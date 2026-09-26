import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { authorizeRuleApplicabilityReviewer, type RuleApplicabilityReviewerPrincipal,
  type RuleApplicabilityReviewerScope } from './rule-applicability-reviewer-grants.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;

export type RuleApplicabilityFieldReviewAction = 'adopt_candidate' | 'request_more_evidence' | 'out_of_scope';

export interface RuleApplicabilityFieldReviewTarget {
  readonly contextId: string;
  readonly contextVersion: number;
  readonly candidateId: string;
  readonly fieldKey: string;
  readonly candidateHash: string;
}

export interface AppendRuleApplicabilityFieldReviewInput {
  readonly principal: RuleApplicabilityReviewerPrincipal;
  readonly scope: RuleApplicabilityReviewerScope;
  readonly target: RuleApplicabilityFieldReviewTarget;
  readonly requestId: string;
  readonly action: RuleApplicabilityFieldReviewAction;
  readonly reason: string;
}

export interface RuleApplicabilityFieldReviewRecord {
  readonly id: string;
  readonly requestId: string;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly contextId: string;
  readonly contextVersion: number;
  readonly contextContentHash: string;
  readonly sourceInputRevision: number;
  readonly sourceInputHash: string;
  readonly candidateId: string;
  readonly fieldKey: string;
  readonly candidateOrdinal: number;
  readonly candidateHash: string;
  readonly candidateValue: unknown;
  readonly conflictRefs: readonly string[];
  readonly sourceKind: string;
  readonly sourceStatus: string;
  readonly action: RuleApplicabilityFieldReviewAction;
  readonly reason: string;
  readonly evidenceRefs: readonly RuleApplicabilityEvidenceRef[];
  readonly reviewerUserId: string;
  readonly reviewerGrantId: string;
  readonly reviewedAt: string;
  readonly replayed: boolean;
}

export interface RuleApplicabilityEvidenceRef {
  readonly materialId: string;
  readonly materialVersion: number;
  readonly materialSha256: string;
  readonly parseSnapshotId: string;
  readonly recordId: string;
  readonly recordSha256: string;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;
type Db = Pick<Pool, 'connect'>;
type JsonRow = Record<string, unknown>;

function error(code: string): Error {
  const result = new Error(code);
  result.name = 'RuleApplicabilityFieldReviewError';
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (value === undefined) throw error('FIELD_REVIEW_INVALID_JSON_VALUE');
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw error('FIELD_REVIEW_INVALID_JSON_VALUE');
  return serialized;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function parseJson(value: unknown): unknown {
  // node-postgres decodes JSONB already; preserve scalar JSON strings as strings.
  return value;
}

function map(row: JsonRow, replayed: boolean): RuleApplicabilityFieldReviewRecord {
  return {
    id: String(row.id), requestId: String(row.request_id), ownerUserId: String(row.owner_user_id),
    projectId: String(row.project_id), contextId: String(row.context_id), contextVersion: Number(row.context_version),
    contextContentHash: String(row.context_content_hash).trim(), sourceInputRevision: Number(row.source_input_revision),
    sourceInputHash: String(row.source_input_hash).trim(), candidateId: String(row.candidate_id),
    fieldKey: String(row.field_key), candidateOrdinal: Number(row.candidate_ordinal),
    candidateHash: String(row.candidate_hash).trim(), candidateValue: parseJson(row.candidate_value),
    conflictRefs: parseJson(row.conflict_refs) as string[], sourceKind: String(row.source_kind),
    sourceStatus: String(row.source_status), action: String(row.action) as RuleApplicabilityFieldReviewAction,
    reason: String(row.reason), evidenceRefs: parseJson(row.evidence_refs) as RuleApplicabilityEvidenceRef[],
    reviewerUserId: String(row.reviewer_user_id), reviewerGrantId: String(row.reviewer_grant_id),
    reviewedAt: new Date(String(row.reviewed_at)).toISOString(), replayed,
  };
}

interface CandidateSnapshot extends JsonRow {
  readonly id: string;
  readonly version: number;
  readonly content_hash: string;
  readonly source_input_revision: number;
  readonly source_input_hash: string;
  readonly candidate_id: string;
  readonly field_key: string;
  readonly ordinal: number;
  readonly candidate_value: unknown;
  readonly conflict_refs: unknown;
  readonly source_kind: string;
  readonly source_status: string;
  readonly evidence_refs: readonly RuleApplicabilityEvidenceRef[];
  readonly candidate_snapshot: Record<string, unknown>;
  readonly candidate_hash: string;
}

async function readSnapshot(client: Queryable, scope: RuleApplicabilityReviewerScope,
  target: RuleApplicabilityFieldReviewTarget, lock: boolean): Promise<CandidateSnapshot> {
  if (lock) {
    const locked = await client.query(`SELECT d.id FROM bb_rule_applicability_context_drafts d
      JOIN bb_rule_applicability_context_candidates c ON c.owner_user_id=d.owner_user_id AND c.project_id=d.project_id
        AND c.context_id=d.id AND c.context_version=d.version
      WHERE d.owner_user_id=$1 AND d.project_id=$2 AND d.id=$3 AND d.version=$4
        AND c.candidate_id=$5 AND c.field_key=$6 FOR SHARE OF d,c`,
    [scope.ownerUserId, scope.projectId, target.contextId, target.contextVersion, target.candidateId, target.fieldKey]);
    if (!locked.rows.length) throw error('FIELD_REVIEW_CANDIDATE_NOT_FOUND');
  }
  const result = await client.query(`SELECT d.id,d.version,d.content_hash,d.source_input_revision,d.source_input_hash,
      c.candidate_id,c.field_key,c.ordinal,c.candidate_value,c.conflict_refs,c.source_kind,c.source_status,
      COALESCE(jsonb_agg(jsonb_build_object('materialId',e.material_id,'materialVersion',e.material_version,
        'materialSha256',trim(e.material_sha256),'parseSnapshotId',e.parse_snapshot_id,
        'recordId',e.evidence_record_id,'recordSha256',trim(e.evidence_record_sha256))
        ORDER BY e.evidence_record_id) FILTER (WHERE e.evidence_record_id IS NOT NULL),'[]'::jsonb) AS evidence_refs,
      bb_rule_applicability_candidate_snapshot(d.owner_user_id,d.project_id,d.id,d.version,c.candidate_id) AS candidate_snapshot,
      encode(sha256(convert_to(bb_rule_applicability_candidate_snapshot(d.owner_user_id,d.project_id,d.id,d.version,c.candidate_id)::text,'UTF8')),'hex') AS candidate_hash
    FROM bb_rule_applicability_context_drafts d
    JOIN bb_rule_applicability_context_candidates c ON c.owner_user_id=d.owner_user_id AND c.project_id=d.project_id
      AND c.context_id=d.id AND c.context_version=d.version
    LEFT JOIN bb_rule_applicability_context_candidate_evidence e ON e.owner_user_id=c.owner_user_id AND e.project_id=c.project_id
      AND e.context_id=c.context_id AND e.context_version=c.context_version AND e.candidate_id=c.candidate_id
    WHERE d.owner_user_id=$1 AND d.project_id=$2 AND d.id=$3 AND d.version=$4
      AND c.candidate_id=$5 AND c.field_key=$6
    GROUP BY d.id,d.version,d.content_hash,d.source_input_revision,d.source_input_hash,
      c.candidate_id,c.field_key,c.ordinal,c.candidate_value,c.conflict_refs,c.source_kind,c.source_status`,
  [scope.ownerUserId, scope.projectId, target.contextId, target.contextVersion, target.candidateId, target.fieldKey]);
  const row = result.rows[0];
  if (!row) throw error('FIELD_REVIEW_CANDIDATE_NOT_FOUND');
  const parsed = { ...row, candidate_value: parseJson(row.candidate_value), conflict_refs: parseJson(row.conflict_refs),
    evidence_refs: parseJson(row.evidence_refs), candidate_snapshot: parseJson(row.candidate_snapshot) } as CandidateSnapshot;
  return parsed;
}

function candidateHash(row: CandidateSnapshot): string {
  return String(row.candidate_hash);
}

function validate(input: AppendRuleApplicabilityFieldReviewInput): void {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!input || !input.principal || !ID.test(input.principal.userId) || !input.scope ||
      !ID.test(input.scope.ownerUserId) || !ID.test(input.scope.projectId) ||
      !input.target || !ID.test(input.target.contextId) || !Number.isSafeInteger(input.target.contextVersion) || input.target.contextVersion < 1 ||
      !ID.test(input.target.candidateId) || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(input.target.fieldKey) ||
      !SHA.test(input.target.candidateHash) || !ID.test(input.requestId) ||
      !['adopt_candidate','request_more_evidence','out_of_scope'].includes(input.action) || !reason || reason.length > 2048)
    throw error('FIELD_REVIEW_INVALID_REQUEST');
}

function validateAdoption(snapshot: CandidateSnapshot, action: RuleApplicabilityFieldReviewAction): void {
  if (action !== 'adopt_candidate') return;
  if (snapshot.source_kind !== 'parse_evidence' || snapshot.source_status !== 'recognized' ||
      snapshot.candidate_value === null || snapshot.evidence_refs.length === 0 ||
      (Array.isArray(snapshot.conflict_refs) && snapshot.conflict_refs.length > 0) ||
      ['market','offering','industry','specialFeatures'].includes(snapshot.field_key))
    throw error('FIELD_REVIEW_CANDIDATE_NOT_ADOPTABLE');
}

function requestHash(input: AppendRuleApplicabilityFieldReviewInput, reviewerUserId: string, grantId: string): string {
  return hash({ ownerUserId: input.scope.ownerUserId, projectId: input.scope.projectId,
    contextId: input.target.contextId, contextVersion: input.target.contextVersion,
    candidateId: input.target.candidateId, fieldKey: input.target.fieldKey,
    candidateHash: input.target.candidateHash, reviewerUserId, grantId,
    action: input.action, reason: input.reason.trim() });
}

async function loadPrior(client: PoolClient, scope: RuleApplicabilityReviewerScope, requestId: string): Promise<JsonRow | undefined> {
  const result = await client.query(`SELECT * FROM bb_rule_applicability_field_reviews
    WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`, [scope.ownerUserId, scope.projectId, requestId]);
  return result.rows[0] as JsonRow | undefined;
}

/** Reads a candidate and its exact provenance only for a currently authorized reviewer. */
export async function getRuleApplicabilityFieldReviewTarget(
  db: Db,
  principal: RuleApplicabilityReviewerPrincipal,
  scope: RuleApplicabilityReviewerScope,
  target: Omit<RuleApplicabilityFieldReviewTarget, 'candidateHash'>,
): Promise<{ readonly candidateHash: string; readonly sourceKind: string; readonly sourceStatus: string;
  readonly evidenceRefs: readonly RuleApplicabilityEvidenceRef[] } | null> {
  if (!principal || !ID.test(principal.userId) || !scope || !ID.test(scope.ownerUserId) || !ID.test(scope.projectId) ||
      !target || !ID.test(target.contextId) || !Number.isSafeInteger(target.contextVersion) || target.contextVersion < 1 ||
      !ID.test(target.candidateId) || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(target.fieldKey)) return null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const reviewer = await authorizeRuleApplicabilityReviewer(client, principal, scope);
    if (!reviewer) { await client.query('ROLLBACK'); return null; }
    const snapshot = await readSnapshot(client, scope, { ...target, candidateHash: '0'.repeat(64) }, true);
    await client.query('COMMIT');
    return { candidateHash: candidateHash(snapshot), sourceKind: snapshot.source_kind,
      sourceStatus: snapshot.source_status, evidenceRefs: snapshot.evidence_refs };
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (cause instanceof Error && cause.name === 'RuleApplicabilityFieldReviewError' && cause.message === 'FIELD_REVIEW_CANDIDATE_NOT_FOUND') return null;
    throw cause;
  } finally { await client.release(); }
}

/** Read one historical action only within a currently authorized exact owner/project scope. */
export async function getRuleApplicabilityFieldReview(
  db: Db,
  principal: RuleApplicabilityReviewerPrincipal,
  scope: RuleApplicabilityReviewerScope,
  reviewId: string,
): Promise<RuleApplicabilityFieldReviewRecord | null> {
  if (!principal || !ID.test(principal.userId) || !scope || !ID.test(scope.ownerUserId) ||
      !ID.test(scope.projectId) || !ID.test(reviewId)) return null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const reviewer = await authorizeRuleApplicabilityReviewer(client, principal, scope);
    if (!reviewer) { await client.query('ROLLBACK'); return null; }
    const result = await client.query(`SELECT * FROM bb_rule_applicability_field_reviews
      WHERE id=$1 AND owner_user_id=$2 AND project_id=$3`, [reviewId, scope.ownerUserId, scope.projectId]);
    await client.query('COMMIT');
    return result.rows[0] ? map(result.rows[0] as JsonRow, false) : null;
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally { await client.release(); }
}

/** Append a field action. It never updates candidates or produces an eligible/approved context. */
export async function appendRuleApplicabilityFieldReview(
  db: Db,
  input: AppendRuleApplicabilityFieldReviewInput,
): Promise<RuleApplicabilityFieldReviewRecord> {
  validate(input);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const reviewer = await authorizeRuleApplicabilityReviewer(client, input.principal, input.scope);
    if (!reviewer) throw error('FIELD_REVIEW_REVIEWER_NOT_AUTHORIZED');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`${input.scope.ownerUserId}:${input.scope.projectId}:rule-field-review:${input.requestId}`]);
    const snapshot = await readSnapshot(client, input.scope, input.target, true);
    const calculatedCandidateHash = candidateHash(snapshot);
    if (calculatedCandidateHash !== input.target.candidateHash) throw error('FIELD_REVIEW_CANDIDATE_HASH_MISMATCH');
    validateAdoption(snapshot, input.action);
    const reqHash = requestHash(input, reviewer.userId, reviewer.grantId);
    const prior = await loadPrior(client, input.scope, input.requestId);
    if (prior) {
      if (String(prior.request_hash).trim() !== reqHash) throw error('FIELD_REVIEW_IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return map(prior, true);
    }
    const id = randomUUID();
    const result = await client.query(`INSERT INTO bb_rule_applicability_field_reviews
      (id,request_id,request_hash,owner_user_id,project_id,context_id,context_version,context_content_hash,
       source_input_revision,source_input_hash,candidate_id,field_key,candidate_ordinal,candidate_hash,candidate_snapshot,candidate_value,
       conflict_refs,source_kind,source_status,action,reason,evidence_refs,reviewer_user_id,reviewer_grant_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22::jsonb,$23,$24)
      RETURNING *`, [id, input.requestId, reqHash, input.scope.ownerUserId, input.scope.projectId,
      snapshot.id, snapshot.version, snapshot.content_hash, snapshot.source_input_revision, snapshot.source_input_hash,
      snapshot.candidate_id, snapshot.field_key, snapshot.ordinal, calculatedCandidateHash,
      JSON.stringify(snapshot.candidate_snapshot), JSON.stringify(snapshot.candidate_value), JSON.stringify(snapshot.conflict_refs), snapshot.source_kind,
      snapshot.source_status, input.action, input.reason.trim(), JSON.stringify(snapshot.evidence_refs), reviewer.userId, reviewer.grantId]);
    const inserted = result.rows[0] as JsonRow;
    await client.query(`INSERT INTO bb_outbox (id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'rule_applicability_field_review',$3,'rule_applicability.field_review_recorded',$4::jsonb)`,
    [randomUUID(), input.scope.ownerUserId, inserted.id, JSON.stringify({
      review_id: inserted.id, project_id: input.scope.projectId, context_id: snapshot.id,
      context_version: snapshot.version, candidate_id: snapshot.candidate_id, field_key: snapshot.field_key,
      candidate_hash: calculatedCandidateHash, action: input.action, reviewer_user_id: reviewer.userId,
      reviewer_grant_id: reviewer.grantId,
    })]);
    await client.query('COMMIT');
    return map(inserted, false);
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally { await client.release(); }
}
