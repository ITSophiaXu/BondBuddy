import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  loadVerifiedIssuerIdentitySourceRecord,
  listIssuerIdentitySourceRecords,
  reviewIssuerIdentitySourceRecord,
  type IssuerIdentitySourceClient,
  type IssuerIdentitySourceDependencies,
  type IssuerIdentitySourcePool,
} from './issuer-identity-source.js';

const owner = 'identity-owner-a';
const project = 'identity-project-a';
const material = 'identity-material-a';
const evidenceId = 'identity-evidence-a';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = { ownerUserId: owner, projectId: project, materialId: material, materialVersion: 1 };
const verifiedA = { verifiedEntityId: 'uscc:91310000MA1FL00008', entityBasisKind: 'uscc' as const,
  entityBasisRef: '91310000MA1FL00008' };
const verifiedB = { verifiedEntityId: 'entity:22222222-2222-4222-8222-222222222222', entityBasisKind: 'manual_attestation' as const,
  entityBasisRef: 'synthetic identity basis B' };
const input = (overrides: Record<string, unknown> = {}) => ({ ...scope, requestId: 'identity-request-a',
  sourceRecordId: evidenceId, issuerDisplayName: '合成发行人甲', entityId: 'entity-issuer-a', ...overrides });

const sourceAnchor = {
  snapshot_id: 'identity-snapshot-a', record_id: evidenceId, record_sha256: sha('record-a'), content_sha256: sha('material-a'),
  locator_type: 'pdf_bbox', locator: { page: 1, bbox: [0, 0, 1, 1] }, literal_quote: '合成发行人甲', response_status: 'parsed',
};

class MemoryClient implements IssuerIdentitySourceClient, IssuerIdentitySourcePool {
  records: Record<string, unknown>[] = [];
  reviews: Record<string, unknown>[] = [];
  outbox: Record<string, unknown>[] = [];
  grants = new Map<string, { userId: string; ownerUserId: string | null; projectId: string | null; revoked: boolean }>();
  anchors = new Map<string, typeof sourceAnchor>([[`${owner}|${project}|${material}|1|${evidenceId}`, sourceAnchor]]);
  materialScopes = new Set([`${owner}|${project}|${material}|1`]);
  calls: { sql: string; values: unknown[] }[] = [];
  failOutbox = false;
  private snapshot: { records: Record<string, unknown>[]; reviews: Record<string, unknown>[]; outbox: Record<string, unknown>[] } | null = null;

  async connect(): Promise<IssuerIdentitySourceClient> { return this; }
  release(): void { /* shared in-memory transaction adapter */ }
  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') { this.snapshot = structuredClone({ records: this.records, reviews: this.reviews, outbox: this.outbox }); return { rows: [] }; }
    if (sql === 'COMMIT') { this.snapshot = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') { if (this.snapshot) Object.assign(this, this.snapshot); this.snapshot = null; return { rows: [] }; }
    if (sql.includes('FROM bb_material_versions') && sql.includes('FOR UPDATE')) {
      const key = values.slice(0, 4).join('|'); return { rows: this.materialScopes.has(key) ? [{ id: values[2] }] : [] };
    }
    if (sql.includes('FROM bb_material_versions m JOIN bb_projects')) {
      const key = values.slice(0, 4).join('|'); return { rows: this.materialScopes.has(key) ? [{ id: values[2] }] : [] };
    }
    if (sql.includes('FROM bb_issuer_identity_source_records r') && sql.includes('request_id=$5')) {
      return { rows: this.records.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3] && row.request_id === values[4]).map(row => this.withReview(row)) };
    }
    if (sql.includes('FROM bb_parse_evidence e') && sql.includes('FOR SHARE OF e')) {
      const key = values.slice(0, 5).join('|'); const anchor = this.anchors.get(key);
      return { rows: anchor ? [anchor as unknown as Record<string, unknown>] : [] };
    }
    if (sql.includes('max(identity_version)')) {
      const rows: Record<string, unknown>[] = this.records.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3]);
      return { rows: [{ identity_version: rows.length ? Math.max(...rows.map(row => Number(row.identity_version))) : 0 }] };
    }
    if (sql.startsWith('INSERT INTO bb_issuer_identity_source_records')) {
      const row = { id: values[0], owner_user_id: values[1], project_id: values[2], material_id: values[3], material_version: values[4],
        snapshot_id: values[5], source_record_id: values[6], source_record_sha256: values[7], source_content_sha256: values[8],
        source_locator_type: values[9], source_locator: JSON.parse(String(values[10])), source_quote: values[11],
        issuer_display_name: values[12], entity_id: values[13], identity_version: values[14], request_id: values[15],
        request_hash: values[16], content_sha256: values[17], state: 'needs_review', created_at: new Date('2026-09-25T00:00:00Z') };
      this.records.push(row); return { rows: [{ ...row, review_decision: null }] };
    }
    if (sql.startsWith('INSERT INTO bb_issuer_identity_source_reviews')) {
      const row = { id: values[0], owner_user_id: values[1], project_id: values[2], material_id: values[3], material_version: values[4],
        source_record_id: values[5], identity_version: values[6], content_sha256: values[7], entity_id: values[8],
        reviewer_user_id: values[9], reviewer_grant_id: values[10], decision: values[11], reason_code: values[12],
        verified_entity_id: values[13], entity_basis_kind: values[14], entity_basis_ref: values[15],
        created_at: new Date('2026-09-25T00:00:00Z') };
      this.reviews.push(row); return { rows: [{ created_at: row.created_at }] };
    }
    if (sql.includes('FROM bb_issuer_identity_reviewer_grants')) {
      if (!sql.includes('WHERE id=$1')) {
        const grants = [...this.grants].filter(([, grant]) => grant.userId === values[0] && !grant.revoked &&
          grant.ownerUserId === values[1] && grant.projectId === values[2]);
        return { rows: grants.map(([key]) => ({ id: key.slice(String(values[0]).length + 1) })) };
      }
      const key = `${String(values[1])}|${String(values[0])}`;
      const grant = this.grants.get(key);
      return { rows: grant && !grant.revoked && grant.userId === String(values[1]) &&
        grant.ownerUserId === String(values[2]) && grant.projectId === String(values[3]) ? [{ id: values[0] }] : [] };
    }
    if (sql.includes('FROM bb_issuer_identity_source_records') && sql.includes('FOR UPDATE')) {
      return { rows: this.records.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3] && row.id === values[4]) };
    }
    if (sql.includes('FROM bb_issuer_identity_source_reviews') && sql.includes('source_record_id=$5')) {
      return { rows: this.reviews.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3] && row.source_record_id === values[4]) };
    }
    if (sql.includes('FROM bb_issuer_identity_source_records r') && sql.includes('ORDER BY r.identity_version DESC')) {
      const rows = this.records.filter(row => row.owner_user_id === values[0] && row.project_id === values[1] &&
        row.material_id === values[2] && row.material_version === values[3]).map(row => {
          const review = this.reviews.find(item => item.source_record_id === row.id);
          const grantActive = review && !this.grants.get(`${String(review.reviewer_user_id)}|${String(review.reviewer_grant_id)}`)?.revoked;
          return { ...this.withReview(row), decision: review?.decision, reviewer_user_id: review?.reviewer_user_id,
            verified_entity_id: review?.verified_entity_id, entity_basis_kind: review?.entity_basis_kind,
            entity_basis_ref: review?.entity_basis_ref,
            reviewed_at: review?.created_at, active_grant_id: grantActive ? review?.reviewer_grant_id : null } as Record<string, unknown>;
        }).sort((a, b) => Number(b.identity_version) - Number(a.identity_version));
      return { rows };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      if (this.failOutbox) throw new Error('synthetic outbox failure');
      this.outbox.push({ id: values[0], owner_user_id: values[1], aggregate_type: 'project', aggregate_id: values[2],
        event_type: sql.includes('issuer.identity_source.reviewed') ? 'issuer.identity_source.reviewed' : 'issuer.identity_source.needs_review',
        payload: JSON.parse(String(values[3])) });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  private withReview(row: Record<string, unknown>): Record<string, unknown> {
    const review = this.reviews.find(item => item.source_record_id === row.id);
    return { ...row, review_decision: review?.decision ?? null };
  }
}

function dependencies(client: MemoryClient): IssuerIdentitySourceDependencies {
  return { pool: client, newId: (() => { let id = 0; return () => `identity-row-${++id}`; })() };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('source records bind one owner/project/material-version anchor, are idempotent, versioned and hashed', async () => {
  const client = new MemoryClient(); const deps = dependencies(client);
  const first = await appendIssuerIdentitySourceRecord(deps, input());
  assert.equal(first.state, 'needs_review'); assert.equal(first.identityVersion, 1);
  assert.equal(first.sourceQuote, sourceAnchor.literal_quote); assert.match(first.contentSha256, /^[a-f0-9]{64}$/);
  const replay = await appendIssuerIdentitySourceRecord(deps, input());
  assert.equal(replay.id, first.id); assert.equal(replay.replayed, true); assert.equal(client.outbox.length, 1);
  await assert.rejects(appendIssuerIdentitySourceRecord(deps, input({ issuerDisplayName: '另一名称' })), /IDEMPOTENCY_CONFLICT/);

  const foreign = await loadVerifiedIssuerIdentitySourceRecord(client, { ...scope, ownerUserId: 'identity-owner-b' });
  assert.equal(foreign, null);
  await assert.rejects(appendIssuerIdentitySourceRecord(deps, input({ requestId: 'identity-request-b', sourceRecordId: 'foreign-evidence' })), /EVIDENCE_NOT_FOUND/);
  assert.ok(client.calls.filter(call => call.sql.includes('bb_parse_evidence e')).every(call =>
    call.values[0] === owner && call.values[1] === project && call.values[2] === material && call.values[3] === 1));

  client.anchors.set(`${owner}|${project}|${material}|1|identity-evidence-b`, { ...sourceAnchor,
    record_id: 'identity-evidence-b', record_sha256: sha('record-b'), literal_quote: '合成发行人甲（曾用名）' });
  const second = await appendIssuerIdentitySourceRecord(deps, input({ requestId: 'identity-request-b',
    sourceRecordId: 'identity-evidence-b', issuerDisplayName: '合成发行人甲（曾用名）' }));
  assert.equal(second.identityVersion, 2); assert.notEqual(second.contentSha256, first.contentSha256);
});

test('no reviewer grant means no verified binding; active grant and exact evidence decision are required', async () => {
  const client = new MemoryClient(); const deps = dependencies(client);
  const record = await appendIssuerIdentitySourceRecord(deps, input());
  assert.equal(await loadVerifiedIssuerIdentitySourceRecord(client, scope), null);
  assert.equal(await authorizeIssuerIdentityReviewer(client, 'reviewer-a', scope), null);
  await assert.rejects(reviewIssuerIdentitySourceRecord(deps, { ...scope, sourceRecordRowId: record.id,
    reviewer: { userId: 'reviewer-a', grantId: 'missing-grant' } as never,
    decision: 'verified', ...verifiedA, reasonCode: 'identity_matches_source' }), /INVALID_ISSUER_IDENTITY_REVIEW/);
  client.grants.set('reviewer-a|review-grant-a', { userId: 'reviewer-a', ownerUserId: owner, projectId: project, revoked: false });
  const reviewer = await authorizeIssuerIdentityReviewer(client, 'reviewer-a', scope); assert.ok(reviewer);
  const reviewed = await reviewIssuerIdentitySourceRecord(deps, { ...scope, sourceRecordRowId: record.id,
    reviewer, decision: 'verified', ...verifiedA, reasonCode: 'identity_matches_source' });
  assert.equal(reviewed.replayed, false);
  const replay = await reviewIssuerIdentitySourceRecord(deps, { ...scope, sourceRecordRowId: record.id,
    reviewer, decision: 'verified', ...verifiedA, reasonCode: 'identity_matches_source' });
  assert.equal(replay.replayed, true); assert.equal(replay.reviewId, reviewed.reviewId);
  await assert.rejects(reviewIssuerIdentitySourceRecord(deps, { ...scope, sourceRecordRowId: record.id,
    reviewer, decision: 'rejected', reasonCode: 'different_decision' }),
  /ALREADY_DECIDED/);
  const verified = await loadVerifiedIssuerIdentitySourceRecord(client, scope);
  assert.equal(verified?.recordId, record.id); assert.equal(verified?.version, record.identityVersion);
  assert.equal(verified?.contentHash, record.contentSha256); assert.equal(verified?.entityId, verifiedA.verifiedEntityId);
  client.reviews[0]!.verified_entity_id = null;
  assert.equal(await loadVerifiedIssuerIdentitySourceRecord(client, scope), null, 'legacy verified review without a verified entity remains unbound');
});

test('parallel project grants are selected exactly; unscoped and cross-project contexts cannot review', async () => {
  const client = new MemoryClient(); const deps = dependencies(client);
  const otherScope = { ownerUserId: 'identity-owner-b', projectId: 'identity-project-b', materialId: 'identity-material-b', materialVersion: 1 };
  client.materialScopes.add(`${otherScope.ownerUserId}|${otherScope.projectId}|${otherScope.materialId}|1`);
  client.anchors.set(`${otherScope.ownerUserId}|${otherScope.projectId}|${otherScope.materialId}|1|identity-evidence-b`, {
    ...sourceAnchor, snapshot_id: 'identity-snapshot-b', record_id: 'identity-evidence-b', record_sha256: sha('record-b'),
    content_sha256: sha('material-b'), literal_quote: '合成发行人乙',
  });
  const sourceA = await appendIssuerIdentitySourceRecord(deps, input());
  const sourceB = await appendIssuerIdentitySourceRecord(deps, { ...otherScope, requestId: 'identity-request-b',
    sourceRecordId: 'identity-evidence-b', issuerDisplayName: '合成发行人乙', entityId: 'entity-issuer-b' });
  client.grants.set('reviewer-a|legacy-grant', { userId: 'reviewer-a', ownerUserId: null, projectId: null, revoked: false });
  client.grants.set('reviewer-a|grant-a', { userId: 'reviewer-a', ownerUserId: owner, projectId: project, revoked: false });
  client.grants.set('reviewer-a|grant-b', { userId: 'reviewer-a', ownerUserId: otherScope.ownerUserId, projectId: otherScope.projectId, revoked: false });

  const reviewerA = await authorizeIssuerIdentityReviewer(client, 'reviewer-a', scope);
  const reviewerB = await authorizeIssuerIdentityReviewer(client, 'reviewer-a', otherScope);
  assert.equal(reviewerA?.grantId, 'grant-a'); assert.equal(reviewerB?.grantId, 'grant-b');
  assert.equal(await authorizeIssuerIdentityReviewer(client, 'reviewer-legacy-only', scope), null);
  await assert.rejects(reviewIssuerIdentitySourceRecord(deps, { ...otherScope, sourceRecordRowId: sourceB.id,
    reviewer: reviewerA!, decision: 'verified', ...verifiedA, reasonCode: 'cross_project_attempt' }), /REVIEWER_NOT_AUTHORIZED/);
  await reviewIssuerIdentitySourceRecord(deps, { ...scope, sourceRecordRowId: sourceA.id,
    reviewer: reviewerA!, decision: 'verified', ...verifiedA, reasonCode: 'project_a_review' });
  await reviewIssuerIdentitySourceRecord(deps, { ...otherScope, sourceRecordRowId: sourceB.id,
    reviewer: reviewerB!, decision: 'verified', ...verifiedB, reasonCode: 'project_b_review' });
});

test('multiple conflicting verified entities never resolve by first-row ordering; unreviewed observations block', async () => {
  const client = new MemoryClient(); const deps = dependencies(client);
  const first = await appendIssuerIdentitySourceRecord(deps, input());
  client.grants.set('reviewer-a|review-grant-a', { userId: 'reviewer-a', ownerUserId: owner, projectId: project, revoked: false });
  const reviewer = await authorizeIssuerIdentityReviewer(client, 'reviewer-a', scope); assert.ok(reviewer);
  const review = (record: typeof first, decision: 'verified' | 'rejected' | 'conflict' = 'verified') => reviewIssuerIdentitySourceRecord(deps, {
    ...scope, sourceRecordRowId: record.id, reviewer, decision, ...(decision === 'verified' ? (record === first ? verifiedA : verifiedB) : {}), reasonCode: 'source_identity_reviewed',
  });
  await review(first);
  client.anchors.set(`${owner}|${project}|${material}|1|identity-evidence-b`, { ...sourceAnchor,
    record_id: 'identity-evidence-b', record_sha256: sha('record-b'), literal_quote: '另一个发行人名称' });
  const second = await appendIssuerIdentitySourceRecord(deps, input({ requestId: 'identity-request-b', sourceRecordId: 'identity-evidence-b',
    issuerDisplayName: '另一个发行人', entityId: 'entity-issuer-b' }));
  assert.equal(await loadVerifiedIssuerIdentitySourceRecord(client, scope), null);
  await review(second);
  assert.equal(await loadVerifiedIssuerIdentitySourceRecord(client, scope), null);
});

test('observation and review outbox append atomically; evidence or outbox failure cannot create a row', async () => {
  const client = new MemoryClient(); const deps = dependencies(client);
  client.failOutbox = true;
  await assert.rejects(appendIssuerIdentitySourceRecord(deps, input()), /outbox failure/);
  assert.equal(client.records.length, 0); assert.equal(client.outbox.length, 0);
  client.failOutbox = false;
  const record = await appendIssuerIdentitySourceRecord(deps, input());
  client.grants.set('reviewer-a|review-grant-a', { userId: 'reviewer-a', ownerUserId: owner, projectId: project, revoked: false }); const reviewer = await authorizeIssuerIdentityReviewer(client, 'reviewer-a', scope); assert.ok(reviewer); client.failOutbox = true;
  await assert.rejects(reviewIssuerIdentitySourceRecord(deps, { ...scope, sourceRecordRowId: record.id,
    reviewer, decision: 'verified', ...verifiedA, reasonCode: 'identity_matches_source' }), /outbox failure/);
  assert.equal(client.reviews.length, 0); assert.equal(await loadVerifiedIssuerIdentitySourceRecord(client, scope), null);
});

const databaseUrl = process.env.BB_TEST_DATABASE_URL;
test('PostgreSQL 16: owner/evidence binding, privileged review, append-only versions, conflict gate and hash verification',
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const ownerId = `issuer-owner-${suffix}`, foreignOwnerId = `issuer-foreign-${suffix}`;
    const reviewerId = `issuer-reviewer-${suffix}`, grantorId = `issuer-grantor-${suffix}`;
    const projectId = `issuer-project-${suffix}`, materialId = `issuer-material-${suffix}`, uploadId = `issuer-upload-${suffix}`;
    const snapshotId = `issuer-snapshot-${suffix}`, contentHash = sha(`synthetic material ${suffix}`);
    const recordA = `issuer-anchor-a-${suffix}`, recordB = `issuer-anchor-b-${suffix}`;
    const grantId = `issuer-review-grant-${suffix}`;
    try {
      await connection.query('BEGIN');
      for (const [id, prefix] of [[ownerId, 'owner'], [foreignOwnerId, 'foreign'], [reviewerId, 'reviewer'], [grantorId, 'grantor']] as const) {
        await connection.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `i${prefix}${suffix}`]);
      }
      await connection.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,\'update\')',
        [projectId, ownerId, `synthetic issuer identity ${suffix}`]);
      await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'audit.pdf','application/pdf',10,$4,'audit',$5,now()+interval '1 hour','completed')`,
        [uploadId, ownerId, projectId, contentHash, `synthetic/${suffix}/upload`]);
      await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'audit','audit.pdf','application/pdf',10,$5,$6,'parsed')`,
        [materialId, ownerId, projectId, uploadId, contentHash, `users/${ownerId}/projects/${projectId}/audit`]);
      const responseMeta = { schema_version: 'document-parse-response-v1', request_id: `request-${suffix}`, status: 'parsed',
        parser_version: `parser-${suffix}`, material: { material_id: materialId, material_version: 1, media_type: 'application/pdf', sha256: contentHash },
        warnings: [], document: { page_count: 1 }, error: null };
      await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,2,$9::jsonb)`,
        [snapshotId, ownerId, projectId, materialId, contentHash, `parser-${suffix}`, sha('request'), sha('response'), JSON.stringify(responseMeta)]);
      for (const [recordId, quote, ordinal] of [[recordA, '合成发行人甲', 0], [recordB, '另一发行人乙', 1]] as const) {
        await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,
          literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
          VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic test evidence','native_text',$9,0.99,'[]','{}',$10,$11)`,
          [ownerId, projectId, materialId, snapshotId, recordId, contentHash, JSON.stringify({ page: ordinal + 1, bbox: [0, 0, 1, 1] }),
            quote, `parser-${suffix}`, sha(recordId), ordinal]);
      }

      let savepointNo = 0;
      const scopedPool: IssuerIdentitySourcePool = {
        query: (sql, values) => connection.query(sql, values),
        connect: async () => {
          const name = `issuer_identity_${++savepointNo}`;
          return { release: () => undefined, query: async (sql, values) => {
            if (sql === 'BEGIN') return connection.query(`SAVEPOINT ${name}`, values);
            if (sql === 'COMMIT') return connection.query(`RELEASE SAVEPOINT ${name}`, values);
            if (sql === 'ROLLBACK') return connection.query(`ROLLBACK TO SAVEPOINT ${name}`, values);
            return connection.query(sql, values);
          } };
        },
      };
      const deps: IssuerIdentitySourceDependencies = { pool: scopedPool, newId: randomUUID };
      const liveScope = { ownerUserId: ownerId, projectId, materialId, materialVersion: 1 };
      const observationA = await appendIssuerIdentitySourceRecord(deps, { ...liveScope, requestId: `request-a-${suffix}`,
        sourceRecordId: recordA, issuerDisplayName: '合成发行人甲', entityId: 'issuer-name:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      assert.equal(observationA.identityVersion, 1);
      assert.equal(await loadVerifiedIssuerIdentitySourceRecord(scopedPool, { ...liveScope, ownerUserId: foreignOwnerId }), null);
      await assert.rejects(appendIssuerIdentitySourceRecord(deps, { ...liveScope, ownerUserId: foreignOwnerId, requestId: `foreign-${suffix}`,
        sourceRecordId: recordA, issuerDisplayName: '合成发行人甲', entityId: 'entity-synthetic-a' }), /MATERIAL_NOT_FOUND/);
      await assert.rejects(appendIssuerIdentitySourceRecord(deps, { ...liveScope, requestId: `wrong-anchor-${suffix}`,
        sourceRecordId: `absent-${suffix}`, issuerDisplayName: '合成发行人甲', entityId: 'entity-synthetic-a' }), /EVIDENCE_NOT_FOUND/);

      const fakeReviewer = { userId: reviewerId, grantId } as never;
      await assert.rejects(reviewIssuerIdentitySourceRecord(deps, { ...liveScope, sourceRecordRowId: observationA.id,
        reviewer: fakeReviewer, decision: 'verified', ...verifiedA, reasonCode: 'identity_verified' }), /INVALID_ISSUER_IDENTITY_REVIEW/);
      const reviewerScope = { ownerUserId: ownerId, projectId };
      const notGranted = await authorizeIssuerIdentityReviewer(scopedPool, reviewerId, reviewerScope);
      assert.equal(notGranted, null);
      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'test_fixture',$4,$5)`, [grantId, reviewerId, grantorId, ownerId, projectId]);
      const reviewer = await authorizeIssuerIdentityReviewer(scopedPool, reviewerId, reviewerScope); assert.ok(reviewer);
      for (const [verifiedEntityId, basisKind, basisRef] of [
        [null, null, null],
        ['issuer-name:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'manual_attestation', 'synthetic basis'],
        ['uscc:91310000MA1FL00008', 'uscc', '91310000MA1FL00009'],
      ]) {
        await connection.query('SAVEPOINT invalid_verified_basis');
        await assert.rejects(connection.query(`INSERT INTO bb_issuer_identity_source_reviews
          (id,owner_user_id,project_id,material_id,material_version,source_record_id,identity_version,content_sha256,entity_id,
           reviewer_user_id,reviewer_grant_id,decision,reason_code,verified_entity_id,entity_basis_kind,entity_basis_ref)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,'verified','synthetic_basis',$11,$12,$13)`,
          [randomUUID(), ownerId, projectId, materialId, observationA.id, observationA.identityVersion,
            observationA.contentSha256, observationA.entityId, reviewerId, grantId, verifiedEntityId, basisKind, basisRef]),
        /bb_issuer_review_verified_entity_basis/);
        await connection.query('ROLLBACK TO SAVEPOINT invalid_verified_basis');
      }
      await reviewIssuerIdentitySourceRecord(deps, { ...liveScope, sourceRecordRowId: observationA.id,
        reviewer, decision: 'verified', ...verifiedA, reasonCode: 'identity_verified' });
      const verified = await loadVerifiedIssuerIdentitySourceRecord(scopedPool, liveScope);
      assert.equal(verified?.recordId, observationA.id);
      assert.equal(verified?.contentHash, observationA.contentSha256);
      assert.equal(verified?.entityId, verifiedA.verifiedEntityId);
      const expectedContentHash = sha(canonical({ ownerUserId: ownerId, projectId, materialId, materialVersion: 1,
        snapshotId, sourceRecordId: recordA, sourceRecordSha256: sha(recordA), sourceContentSha256: contentHash,
        sourceLocatorType: 'pdf_bbox', sourceLocator: { page: 1, bbox: [0, 0, 1, 1] }, sourceQuote: '合成发行人甲',
        issuerDisplayName: '合成发行人甲', entityId: 'issuer-name:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', identityVersion: 1 }));
      assert.equal(verified?.contentHash, expectedContentHash, 'loader returns a hash recomputed from the immutable record fields');

      await connection.query('SAVEPOINT cross_material_same_name');
      const addSameNameMaterial = async (label: string, basis: typeof verifiedA | typeof verifiedB) => {
        const otherMaterialId = `issuer-same-name-${label}-${suffix}`;
        const otherUploadId = `issuer-same-upload-${label}-${suffix}`;
        const otherSnapshotId = `issuer-same-snapshot-${label}-${suffix}`;
        const otherEvidenceId = `issuer-same-evidence-${label}-${suffix}`;
        const otherHash = sha(`synthetic same-name ${label} ${suffix}`);
        await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
          VALUES($1,$2,$3,'same-name.pdf','application/pdf',10,$4,'audit',$5,now()+interval '1 hour','completed')`,
        [otherUploadId, ownerId, projectId, otherHash, `synthetic/${otherUploadId}`]);
        await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,'audit','same-name.pdf','application/pdf',10,$5,$6,'parsed')`,
        [otherMaterialId, ownerId, projectId, otherUploadId, otherHash, `synthetic/${otherMaterialId}`]);
        const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${otherSnapshotId}`, status: 'parsed',
          parser_version: `parser-${suffix}`, material: { material_id: otherMaterialId, material_version: 1,
            media_type: 'application/pdf', sha256: otherHash }, warnings: [], document: { page_count: 1 }, error: null };
        await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
          response_status,response_schema_version,response_sha256,record_count,response_meta)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
        [otherSnapshotId, ownerId, projectId, otherMaterialId, otherHash, `parser-${suffix}`, sha(`request-${label}`),
          sha(`response-${label}`), JSON.stringify(meta)]);
        await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
          locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
          VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,'发行人名称：合成发行人甲。','synthetic same-name evidence','native_text',$8,0.99,'[]','{}',$9,0)`,
        [ownerId, projectId, otherMaterialId, otherSnapshotId, otherEvidenceId, otherHash,
          JSON.stringify({ page: 1, bbox: [0, 0, 1, 1] }), `parser-${suffix}`, sha(otherEvidenceId)]);
        const otherScope = { ownerUserId: ownerId, projectId, materialId: otherMaterialId, materialVersion: 1 };
        const observation = await appendIssuerIdentitySourceRecord(deps, { ...otherScope, requestId: `request-${label}-${suffix}`,
          sourceRecordId: otherEvidenceId, issuerDisplayName: '合成发行人甲', entityId: observationA.entityId });
        await reviewIssuerIdentitySourceRecord(deps, { ...otherScope, sourceRecordRowId: observation.id,
          reviewer, decision: 'verified', ...basis, reasonCode: 'identity_verified' });
        return otherScope;
      };
      const sameEntityMaterial = await addSameNameMaterial('same', verifiedA);
      assert.equal((await loadVerifiedIssuerIdentitySourceRecord(scopedPool, sameEntityMaterial))?.entityId, verifiedA.verifiedEntityId);
      assert.equal((await loadVerifiedIssuerIdentitySourceRecord(scopedPool, liveScope))?.entityId, verifiedA.verifiedEntityId);
      const differentEntityMaterial = await addSameNameMaterial('different', verifiedB);
      assert.equal(await loadVerifiedIssuerIdentitySourceRecord(scopedPool, liveScope), null,
        'same candidate name with different verified entities conflicts across materials');
      assert.equal(await loadVerifiedIssuerIdentitySourceRecord(scopedPool, differentEntityMaterial), null);
      assert.equal((await listIssuerIdentitySourceRecords(scopedPool, liveScope)).status, 'conflict');
      assert.equal((await listIssuerIdentitySourceRecords(scopedPool, differentEntityMaterial)).status, 'conflict');
      await connection.query('ROLLBACK TO SAVEPOINT cross_material_same_name');

      const second = await appendIssuerIdentitySourceRecord(deps, { ...liveScope, requestId: `request-b-${suffix}`,
        sourceRecordId: recordB, issuerDisplayName: '另一发行人乙', entityId: 'entity-synthetic-b' });
      assert.equal(second.identityVersion, 2);
      assert.equal(await loadVerifiedIssuerIdentitySourceRecord(scopedPool, liveScope), null, 'a new pending observation blocks binding');
      await reviewIssuerIdentitySourceRecord(deps, { ...liveScope, sourceRecordRowId: second.id,
        reviewer, decision: 'verified', ...verifiedB, reasonCode: 'identity_verified' });
      assert.equal(await loadVerifiedIssuerIdentitySourceRecord(scopedPool, liveScope), null,
        'two conflicting verified entity IDs never select the first observation');

      for (const mismatch of ['quote', 'content-hash'] as const) {
        const rollbackPoint = `issuer_identity_bad_${mismatch.replace('-', '_')}`;
        await connection.query(`SAVEPOINT ${rollbackPoint}`);
        await assert.rejects(connection.query(`INSERT INTO bb_issuer_identity_source_records
          (id,owner_user_id,project_id,material_id,material_version,snapshot_id,source_record_id,source_record_sha256,source_content_sha256,
           source_locator_type,source_locator,source_quote,issuer_display_name,entity_id,identity_version,request_id,request_hash,content_sha256)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'pdf_bbox',$9::jsonb,$10,'伪造发行人','entity-tampered',$11,$12,$13,$14)`,
          [`bad-${suffix}-${mismatch}`, ownerId, projectId, materialId, snapshotId, recordA,
            sha(recordA), mismatch === 'content-hash' ? sha('wrong material hash') : contentHash,
            JSON.stringify({ page: 1, bbox: [0, 0, 1, 1] }), mismatch === 'quote' ? '伪造的原文' : '合成发行人甲',
            20 + (mismatch === 'quote' ? 1 : 2), `bad-${suffix}-${mismatch}`, sha(`request-${mismatch}`), sha(`content-${mismatch}`)]),
        /issuer identity source evidence mismatch/);
        await connection.query(`ROLLBACK TO SAVEPOINT ${rollbackPoint}`);
      }
      await connection.query(`SAVEPOINT issuer_identity_bad_stored_hash_${suffix}`);
      const tamperedId = `tampered-${suffix}`;
      await connection.query(`INSERT INTO bb_issuer_identity_source_records
        (id,owner_user_id,project_id,material_id,material_version,snapshot_id,source_record_id,source_record_sha256,source_content_sha256,
         source_locator_type,source_locator,source_quote,issuer_display_name,entity_id,identity_version,request_id,request_hash,content_sha256)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'pdf_bbox',$9::jsonb,$10,$11,$12,3,$13,$14,$15)`,
        [tamperedId, ownerId, projectId, materialId, snapshotId, recordB, sha(recordB), contentHash,
          JSON.stringify({ page: 2, bbox: [0, 0, 1, 1] }), '另一发行人乙', '另一发行人乙', 'entity-synthetic-b',
          `tampered-request-${suffix}`, sha('tampered-request'), sha('tampered-record-content')]);
      await connection.query(`INSERT INTO bb_issuer_identity_source_reviews
        (id,owner_user_id,project_id,material_id,material_version,source_record_id,identity_version,content_sha256,entity_id,
         reviewer_user_id,reviewer_grant_id,decision,reason_code,verified_entity_id,entity_basis_kind,entity_basis_ref)
        VALUES($1,$2,$3,$4,1,$5,3,$6,'entity-synthetic-b',$7,$8,'verified','test_fixture',$9,'manual_attestation','synthetic hash check')`,
        [`tampered-review-${suffix}`, ownerId, projectId, materialId, tamperedId, sha('tampered-record-content'), reviewerId, grantId, verifiedB.verifiedEntityId]);
      await assert.rejects(loadVerifiedIssuerIdentitySourceRecord(scopedPool, liveScope), /CONTENT_HASH_MISMATCH/,
        'loader refuses a hash that does not recalculate from the immutable stored record');
      await connection.query(`ROLLBACK TO SAVEPOINT issuer_identity_bad_stored_hash_${suffix}`);
      await connection.query(`SAVEPOINT issuer_identity_immutable_${suffix}`);
      await assert.rejects(connection.query(`UPDATE bb_issuer_identity_source_records SET entity_id='entity-forged' WHERE id=$1`, [observationA.id]), /immutable/);
      await connection.query(`ROLLBACK TO SAVEPOINT issuer_identity_immutable_${suffix}`);
    } finally {
      await connection.query('ROLLBACK');
      connection.release(); await pool.end();
    }
  });
