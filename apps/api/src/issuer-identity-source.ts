import { createHash, randomUUID } from 'node:crypto';

export interface IssuerIdentitySourcePool {
  connect(): Promise<IssuerIdentitySourceClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface IssuerIdentitySourceClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface IssuerIdentitySourceDependencies {
  readonly pool: IssuerIdentitySourcePool;
  readonly newId?: () => string;
}

export interface IssuerIdentitySourceScope {
  /** Must come from the authenticated principal, never from request JSON. */
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly materialId: string;
  readonly materialVersion: number;
}

export interface AppendIssuerIdentitySourceRecordInput extends IssuerIdentitySourceScope {
  readonly requestId: string;
  readonly sourceRecordId: string;
  readonly issuerDisplayName: string;
  /** Internal identity registry key; caller-provided observations remain pending review. */
  readonly entityId: string;
}

export interface StoredIssuerIdentitySourceRecord extends IssuerIdentitySourceScope {
  readonly id: string;
  readonly snapshotId: string;
  readonly sourceRecordId: string;
  readonly sourceRecordSha256: string;
  readonly sourceContentSha256: string;
  readonly sourceLocatorType: string;
  readonly sourceLocator: Record<string, unknown>;
  readonly sourceQuote: string;
  readonly issuerDisplayName: string;
  readonly entityId: string;
  readonly identityVersion: number;
  readonly requestId: string;
  readonly requestHash: string;
  readonly contentSha256: string;
  readonly state: 'needs_review';
  readonly reviewDecision: 'verified' | 'rejected' | 'conflict' | null;
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface ReviewIssuerIdentitySourceRecordInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly materialId: string;
  readonly materialVersion: number;
  readonly sourceRecordRowId: string;
  /** Runtime-branded context returned by authorizeIssuerIdentityReviewer; never request JSON. */
  readonly reviewer: TrustedIssuerIdentityReviewer;
  readonly decision: 'verified' | 'rejected' | 'conflict';
  readonly reasonCode: string;
}

const trustedReviewerBrand: unique symbol = Symbol('TrustedIssuerIdentityReviewer');
const trustedReviewerContexts = new WeakSet<object>();

export interface TrustedIssuerIdentityReviewer {
  readonly userId: string;
  readonly grantId: string;
  readonly [trustedReviewerBrand]: true;
}

export interface VerifiedIssuerIdentitySourceRecord {
  readonly recordId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly entityId: string;
  readonly issuerDisplayName: string;
  readonly materialId: string;
  readonly materialVersion: number;
  readonly sourceSnapshotId: string;
  readonly sourceRecordId: string;
  readonly sourceRecordSha256: string;
  readonly sourceContentSha256: string;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/;

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'IssuerIdentitySourceError';
  return error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_ISSUER_IDENTITY_SOURCE_ROW'); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function validateScope(scope: IssuerIdentitySourceScope): void {
  if (![scope.ownerUserId, scope.projectId, scope.materialId].every(value => typeof value === 'string' && idPattern.test(value)) ||
      !Number.isSafeInteger(scope.materialVersion) || scope.materialVersion < 1) throw fail('INVALID_ISSUER_IDENTITY_SCOPE');
}

function mapRow(row: Record<string, unknown>, replayed: boolean): StoredIssuerIdentitySourceRecord {
  const locator = parseJson(row.source_locator);
  if (!isObject(locator) || row.state !== 'needs_review' || !shaPattern.test(String(row.request_hash).trim()) ||
      !shaPattern.test(String(row.content_sha256).trim()) || !shaPattern.test(String(row.source_record_sha256).trim()) ||
      !shaPattern.test(String(row.source_content_sha256).trim())) throw fail('INVALID_ISSUER_IDENTITY_SOURCE_ROW');
  const content = {
    ownerUserId: String(row.owner_user_id), projectId: String(row.project_id), materialId: String(row.material_id),
    materialVersion: Number(row.material_version), snapshotId: String(row.snapshot_id), sourceRecordId: String(row.source_record_id),
    sourceRecordSha256: String(row.source_record_sha256).trim(), sourceContentSha256: String(row.source_content_sha256).trim(),
    sourceLocatorType: String(row.source_locator_type), sourceLocator: locator, sourceQuote: String(row.source_quote),
    issuerDisplayName: String(row.issuer_display_name), entityId: String(row.entity_id), identityVersion: Number(row.identity_version),
  };
  if (sha256(canonical(content)) !== String(row.content_sha256).trim()) throw fail('ISSUER_IDENTITY_CONTENT_HASH_MISMATCH');
  const review = row.review_decision;
  if (review !== null && review !== undefined && !['verified', 'rejected', 'conflict'].includes(String(review))) {
    throw fail('INVALID_ISSUER_IDENTITY_REVIEW_ROW');
  }
  return {
    ...content, id: String(row.id), requestId: String(row.request_id), requestHash: String(row.request_hash).trim(),
    contentSha256: String(row.content_sha256).trim(), state: 'needs_review',
    reviewDecision: (review ?? null) as StoredIssuerIdentitySourceRecord['reviewDecision'],
    createdAt: new Date(String(row.created_at)).toISOString(), replayed,
  };
}

const recordColumns = `r.id, r.owner_user_id, r.project_id, r.material_id, r.material_version, r.snapshot_id,
  r.source_record_id, r.source_record_sha256, r.source_content_sha256, r.source_locator_type, r.source_locator,
  r.source_quote, r.issuer_display_name, r.entity_id, r.identity_version, r.request_id, r.request_hash,
  r.content_sha256, r.state, rv.decision AS review_decision, r.created_at`;

/**
 * Append one source observation. The evidence anchor is fetched from the immutable parser ledger,
 * never copied from the request. The function always records needs_review.
 */
export async function appendIssuerIdentitySourceRecord(
  dependencies: IssuerIdentitySourceDependencies,
  input: AppendIssuerIdentitySourceRecordInput,
): Promise<StoredIssuerIdentitySourceRecord> {
  validateScope(input);
  const displayName = input.issuerDisplayName.trim();
  if (!idPattern.test(input.requestId) || !idPattern.test(input.sourceRecordId) ||
      !idPattern.test(input.entityId) || !displayName || displayName.length > 512) throw fail('INVALID_ISSUER_IDENTITY_INPUT');
  const requestHash = sha256(canonical({ ownerUserId: input.ownerUserId, projectId: input.projectId,
    materialId: input.materialId, materialVersion: input.materialVersion, requestId: input.requestId,
    sourceRecordId: input.sourceRecordId, issuerDisplayName: displayName, entityId: input.entityId }));
  const db = await dependencies.pool.connect();
  const newId = dependencies.newId ?? randomUUID;
  try {
    await db.query('BEGIN');
    const material = await db.query(
      `SELECT id FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL AND role <> 'reference'
        FOR UPDATE`,
      [input.ownerUserId, input.projectId, input.materialId, input.materialVersion]);
    if (material.rows.length !== 1) throw fail('ISSUER_IDENTITY_MATERIAL_NOT_FOUND');

    const prior = await db.query(
      `SELECT ${recordColumns} FROM bb_issuer_identity_source_records r
        LEFT JOIN bb_issuer_identity_source_reviews rv ON rv.owner_user_id=r.owner_user_id AND rv.project_id=r.project_id
          AND rv.material_id=r.material_id AND rv.material_version=r.material_version AND rv.source_record_id=r.id
        WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.material_id=$3 AND r.material_version=$4 AND r.request_id=$5`,
      [input.ownerUserId, input.projectId, input.materialId, input.materialVersion, input.requestId]);
    if (prior.rows.length) {
      const row = prior.rows[0]!;
      if (String(row.request_hash).trim() !== requestHash) throw fail('ISSUER_IDENTITY_IDEMPOTENCY_CONFLICT');
      const mapped = mapRow(row, true);
      await db.query('COMMIT');
      return mapped;
    }

    const anchorResult = await db.query(
      `SELECT e.snapshot_id, e.record_id, e.record_sha256, e.content_sha256, e.locator_type, e.locator,
              e.literal_quote, s.response_status
         FROM bb_parse_evidence e
         JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
          AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
          AND s.content_sha256=e.content_sha256 AND s.response_status IN ('parsed','needs_confirmation')
         JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
          AND m.id=e.material_id AND m.version=e.material_version AND m.sha256=e.content_sha256 AND m.deleted_at IS NULL
        WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
          AND e.record_id=$5 AND e.uncertainty='[]'::jsonb AND m.role <> 'reference'
        FOR SHARE OF e, s, m`,
      [input.ownerUserId, input.projectId, input.materialId, input.materialVersion, input.sourceRecordId]);
    if (anchorResult.rows.length !== 1) throw fail('ISSUER_IDENTITY_SOURCE_EVIDENCE_NOT_FOUND_OR_UNCERTAIN');
    const anchor = anchorResult.rows[0]!;
    const locator = parseJson(anchor.locator);
    if (!isObject(locator)) throw fail('INVALID_ISSUER_IDENTITY_SOURCE_ANCHOR');
    const latest = await db.query(
      `SELECT COALESCE(max(identity_version),0)::int AS identity_version FROM bb_issuer_identity_source_records
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4`,
      [input.ownerUserId, input.projectId, input.materialId, input.materialVersion]);
    const identityVersion = Number(latest.rows[0]?.identity_version ?? 0) + 1;
    const content = {
      ownerUserId: input.ownerUserId, projectId: input.projectId, materialId: input.materialId,
      materialVersion: input.materialVersion, snapshotId: String(anchor.snapshot_id), sourceRecordId: String(anchor.record_id),
      sourceRecordSha256: String(anchor.record_sha256).trim(), sourceContentSha256: String(anchor.content_sha256).trim(),
      sourceLocatorType: String(anchor.locator_type), sourceLocator: locator, sourceQuote: String(anchor.literal_quote),
      issuerDisplayName: displayName, entityId: input.entityId, identityVersion,
    };
    const contentHash = sha256(canonical(content));
    const inserted = await db.query(
      `INSERT INTO bb_issuer_identity_source_records
       (id, owner_user_id, project_id, material_id, material_version, snapshot_id, source_record_id,
        source_record_sha256, source_content_sha256, source_locator_type, source_locator, source_quote,
        issuer_display_name, entity_id, identity_version, request_id, request_hash, content_sha256, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,'needs_review')
       RETURNING id, owner_user_id, project_id, material_id, material_version, snapshot_id,
         source_record_id, source_record_sha256, source_content_sha256, source_locator_type, source_locator,
         source_quote, issuer_display_name, entity_id, identity_version, request_id, request_hash,
         content_sha256, state, NULL::text AS review_decision, created_at`,
      [newId(), input.ownerUserId, input.projectId, input.materialId, input.materialVersion, String(anchor.snapshot_id),
        String(anchor.record_id), String(anchor.record_sha256).trim(), String(anchor.content_sha256).trim(),
        String(anchor.locator_type), JSON.stringify(locator), String(anchor.literal_quote), displayName, input.entityId,
        identityVersion, input.requestId, requestHash, contentHash]);
    const row = inserted.rows[0];
    if (!row) throw fail('ISSUER_IDENTITY_INSERT_FAILED');
    const mapped = mapRow({ ...row, review_decision: null }, false);
    await db.query(
      `INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'project',$3,'issuer.identity_source.needs_review',$4::jsonb)`,
      [newId(), input.ownerUserId, input.projectId, JSON.stringify({ material_id: input.materialId,
        material_version: input.materialVersion, source_record_row_id: mapped.id,
        identity_version: identityVersion, content_sha256: contentHash, state: 'needs_review' })]);
    await db.query('COMMIT');
    return mapped;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { db.release(); }
}

/** Append a decision only when the reviewer is present in the active database grant ledger. */
export async function reviewIssuerIdentitySourceRecord(
  dependencies: IssuerIdentitySourceDependencies,
  input: ReviewIssuerIdentitySourceRecordInput,
): Promise<{ readonly reviewId: string; readonly sourceRecordId: string; readonly decision: ReviewIssuerIdentitySourceRecordInput['decision']; readonly createdAt: string; readonly replayed: boolean }> {
  validateScope(input);
  if (!idPattern.test(input.sourceRecordRowId) || !trustedReviewerContexts.has(input.reviewer as object) ||
      !['verified', 'rejected', 'conflict'].includes(input.decision) || !reasonPattern.test(input.reasonCode)) {
    throw fail('INVALID_ISSUER_IDENTITY_REVIEW');
  }
  const db = await dependencies.pool.connect();
  const newId = dependencies.newId ?? randomUUID;
  try {
    await db.query('BEGIN');
    const grant = await db.query(
      `SELECT id FROM bb_issuer_identity_reviewer_grants
        WHERE id=$1 AND user_id=$2 AND role='issuer_identity_reviewer' AND revoked_at IS NULL FOR SHARE`,
      [input.reviewer.grantId, input.reviewer.userId]);
    if (grant.rows.length !== 1) throw fail('ISSUER_IDENTITY_REVIEWER_NOT_AUTHORIZED');
    const sourceResult = await db.query(
      `SELECT *, NULL::text AS review_decision FROM bb_issuer_identity_source_records
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND id=$5 FOR UPDATE`,
      [input.ownerUserId, input.projectId, input.materialId, input.materialVersion, input.sourceRecordRowId]);
    if (sourceResult.rows.length !== 1) throw fail('ISSUER_IDENTITY_SOURCE_RECORD_NOT_FOUND');
    const source = sourceResult.rows[0]!;
    mapRow(source, false);
    const prior = await db.query(
      `SELECT id, decision, reason_code, reviewer_user_id, reviewer_grant_id, created_at FROM bb_issuer_identity_source_reviews
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND source_record_id=$5`,
      [input.ownerUserId, input.projectId, input.materialId, input.materialVersion, input.sourceRecordRowId]);
    if (prior.rows.length) {
      const row = prior.rows[0]!;
      if (String(row.decision) !== input.decision || String(row.reason_code) !== input.reasonCode ||
          String(row.reviewer_user_id) !== input.reviewer.userId || String(row.reviewer_grant_id) !== input.reviewer.grantId) {
        throw fail('ISSUER_IDENTITY_REVIEW_ALREADY_DECIDED');
      }
      await db.query('COMMIT');
      return { reviewId: String(row.id), sourceRecordId: input.sourceRecordRowId,
        decision: input.decision, createdAt: new Date(String(row.created_at)).toISOString(), replayed: true };
    }
    const reviewId = newId();
    const inserted = await db.query(
      `INSERT INTO bb_issuer_identity_source_reviews
       (id, owner_user_id, project_id, material_id, material_version, source_record_id, identity_version,
        content_sha256, entity_id, reviewer_user_id, reviewer_grant_id, decision, reason_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING created_at`,
      [reviewId, input.ownerUserId, input.projectId, input.materialId, input.materialVersion, input.sourceRecordRowId,
        Number(source.identity_version), String(source.content_sha256).trim(), String(source.entity_id), input.reviewer.userId,
        input.reviewer.grantId, input.decision, input.reasonCode]);
    await db.query(
      `INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'project',$3,'issuer.identity_source.reviewed',$4::jsonb)`,
      [newId(), input.ownerUserId, input.projectId, JSON.stringify({ material_id: input.materialId,
        material_version: input.materialVersion, source_record_row_id: input.sourceRecordRowId,
        identity_version: Number(source.identity_version), decision: input.decision, reviewer_user_id: input.reviewer.userId })]);
    await db.query('COMMIT');
    return { reviewId, sourceRecordId: input.sourceRecordRowId, decision: input.decision,
      createdAt: new Date(String(inserted.rows[0]?.created_at)).toISOString(), replayed: false };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { db.release(); }
}

/** Resolve an authenticated principal to a server-branded reviewer using the active grant ledger. */
export async function authorizeIssuerIdentityReviewer(
  pool: IssuerIdentitySourcePool,
  authenticatedUserId: string,
): Promise<TrustedIssuerIdentityReviewer | null> {
  if (!idPattern.test(authenticatedUserId)) throw fail('INVALID_ISSUER_IDENTITY_REVIEWER');
  const result = await pool.query(
    `SELECT id FROM bb_issuer_identity_reviewer_grants
      WHERE user_id=$1 AND role='issuer_identity_reviewer' AND revoked_at IS NULL`, [authenticatedUserId]);
  if (result.rows.length !== 1 || !idPattern.test(String(result.rows[0]?.id))) return null;
  const context = Object.freeze({ userId: authenticatedUserId, grantId: String(result.rows[0]!.id), [trustedReviewerBrand]: true as const });
  trustedReviewerContexts.add(context);
  return context;
}

/**
 * Internal #17 handoff. Return an identity only when every source observation in this exact
 * material version has an active-grant review and there is exactly one verified entity ID.
 */
export async function loadVerifiedIssuerIdentitySourceRecord(
  pool: IssuerIdentitySourcePool,
  scope: IssuerIdentitySourceScope,
): Promise<VerifiedIssuerIdentitySourceRecord | null> {
  validateScope(scope);
  const result = await pool.query(
    `SELECT r.*, rv.decision AS review_decision, rv.decision, rv.reason_code AS review_reason_code, rv.id AS review_id,
            rv.reviewer_user_id, rv.created_at AS reviewed_at, g.id AS active_grant_id
       FROM bb_issuer_identity_source_records r
       LEFT JOIN bb_issuer_identity_source_reviews rv ON rv.owner_user_id=r.owner_user_id AND rv.project_id=r.project_id
        AND rv.material_id=r.material_id AND rv.material_version=r.material_version AND rv.source_record_id=r.id
       LEFT JOIN bb_issuer_identity_reviewer_grants g ON g.id=rv.reviewer_grant_id
        AND g.user_id=rv.reviewer_user_id AND g.role='issuer_identity_reviewer' AND g.revoked_at IS NULL
      WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.material_id=$3 AND r.material_version=$4
      ORDER BY r.identity_version DESC`,
    [scope.ownerUserId, scope.projectId, scope.materialId, scope.materialVersion]);
  if (result.rows.length === 0 || result.rows.some(row => !row.active_grant_id || !['verified', 'rejected'].includes(String(row.decision)))) return null;
  const verified = result.rows.filter(row => row.decision === 'verified');
  for (const row of result.rows) mapRow(row, false);
  if (verified.length === 0 || verified.some(row => !shaPattern.test(String(row.content_sha256).trim()))) return null;
  const entities = new Set(verified.map(row => String(row.entity_id)));
  if (entities.size !== 1) return null;
  const row = verified[0]!;
  return {
    recordId: String(row.id), version: Number(row.identity_version), contentHash: String(row.content_sha256).trim(),
    entityId: String(row.entity_id), issuerDisplayName: String(row.issuer_display_name),
    materialId: String(row.material_id), materialVersion: Number(row.material_version),
    sourceSnapshotId: String(row.snapshot_id), sourceRecordId: String(row.source_record_id),
    sourceRecordSha256: String(row.source_record_sha256).trim(), sourceContentSha256: String(row.source_content_sha256).trim(),
    reviewedBy: String(row.reviewer_user_id), reviewedAt: new Date(String(row.reviewed_at)).toISOString(),
  };
}
