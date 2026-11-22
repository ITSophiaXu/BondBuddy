import type { Pool } from 'pg';
import {
  userReferenceParseReviewAccepted,
  validUserReferenceOutline,
  type UserReferenceOutline,
  type UserReferencePin,
} from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { NoHistoryRunScope } from './no-history-model-stage.js';

export type UserReferenceLoad =
  | { status: 'none' }
  | { status: 'needs_review'; reason: string }
  | { status: 'accepted'; outline: UserReferenceOutline };

const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Reads only the immutable approved chapter projection; parser text never reaches the stage. */
export async function loadUserReferenceOutline(
  pool: Pool,
  scope: NoHistoryRunScope,
): Promise<UserReferenceLoad> {
  const input = (
    await pool.query(
      `SELECT manifest,input_hash FROM bb_input_revisions
    WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,
      [scope.ownerUserId, scope.projectId, scope.inputRevision],
    )
  ).rows[0];
  if (
    !input ||
    !hash(scope.inputHash) ||
    input.input_hash.trim() !== scope.inputHash ||
    inputManifestHash(input.manifest) !== scope.inputHash
  )
    return { status: 'needs_review', reason: 'input_lock_invalid' };
  const pin = input.manifest?.user_reference_pin as UserReferencePin | undefined;
  if (!pin) return { status: 'none' };
  if (pin.schema_version !== 'user-reference-pin-v1')
    return { status: 'needs_review', reason: 'pin_invalid' };
  const row = (
    await pool.query(
      `SELECT p.*,m.role,m.sha256 AS current_sha256,m.deleted_at,
    s.content_sha256 AS snapshot_sha256,s.response_sha256 AS snapshot_response_sha256,
    s.response_status,s.response_schema_version,s.record_count,s.response_meta,
    evidence.evidence_count,evidence.uncertain_count,
    r.status AS review_status,r.authorization_status AS review_authorization_status,
    r.readability_status AS review_readability_status,r.applicability_status AS review_applicability_status,
    r.material_sha256 AS review_sha256,r.parse_snapshot_id AS review_snapshot_id,
    r.target_market AS review_market,r.target_offering AS review_offering,
    r.target_product AS review_product,r.target_document_stage AS review_stage,
    r.fact_isolation_check_version AS review_isolation_version,r.outline AS review_outline,
    r.confirmed_warning_codes AS review_warning_codes,r.signed_outline_sha256 AS review_outline_sha256,
    r.parse_response_sha256 AS review_parse_response_sha256,
    r.reviewer_user_id AS review_reviewer_user_id,r.reviewer_grant_id AS review_reviewer_grant_id,
    g.revoked_at AS grant_revoked_at,
    c.status AS context_status,c.content_hash AS context_hash,c.target_market AS context_market,
    c.target_offering AS context_offering,c.target_product AS context_product,
    c.target_document_stage AS context_stage,c.reviewer_user_id AS context_reviewer_user_id,
    c.reviewer_grant_id AS context_reviewer_grant_id,cg.revoked_at AS context_grant_revoked_at
    FROM bb_user_reference_pins p
    JOIN bb_material_versions m ON m.owner_user_id=p.owner_user_id AND m.project_id=p.project_id
      AND m.id=p.material_id AND m.version=p.material_version
    JOIN bb_parse_snapshots s ON s.owner_user_id=p.owner_user_id AND s.project_id=p.project_id
      AND s.material_id=p.material_id AND s.material_version=p.material_version AND s.id=p.parse_snapshot_id
    LEFT JOIN LATERAL (SELECT count(*)::integer AS evidence_count,
      count(*) FILTER (WHERE e.uncertainty <> '[]'::jsonb)::integer AS uncertain_count
      FROM bb_parse_evidence e WHERE e.owner_user_id=p.owner_user_id AND e.project_id=p.project_id
      AND e.material_id=p.material_id AND e.material_version=p.material_version
      AND e.snapshot_id=p.parse_snapshot_id) evidence ON true
    LEFT JOIN bb_user_reference_reviews r ON r.id=p.review_id AND r.owner_user_id=p.owner_user_id
      AND r.project_id=p.project_id AND r.material_id=p.material_id AND r.material_version=p.material_version
    LEFT JOIN bb_user_reference_reviewer_grants g ON g.id=p.reviewer_grant_id AND g.reviewer_user_id=p.reviewer_user_id
    LEFT JOIN bb_user_reference_target_contexts c ON c.id=p.target_context_id AND c.owner_user_id=p.owner_user_id
      AND c.project_id=p.project_id
    LEFT JOIN bb_user_reference_reviewer_grants cg ON cg.id=c.reviewer_grant_id AND cg.reviewer_user_id=c.reviewer_user_id
    WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.input_revision=$3`,
      [scope.ownerUserId, scope.projectId, scope.inputRevision],
    )
  ).rows[0];
  if (
    !row ||
    row.material_id !== pin.material_id ||
    row.material_version !== pin.material_version ||
    row.material_sha256.trim() !== pin.material_sha256 ||
    row.parse_snapshot_id !== pin.parse_snapshot_id ||
    row.parse_response_sha256?.trim() !== pin.parse_response_sha256 ||
    row.status !== pin.status ||
    row.authorization_status !== pin.authorization_status ||
    row.readability_status !== pin.readability_status ||
    row.applicability_status !== pin.applicability_status ||
    row.target_market !== pin.target_market ||
    row.target_offering !== pin.target_offering ||
    row.target_product !== pin.target_product ||
    row.target_document_stage !== pin.target_document_stage ||
    row.target_context_id !== pin.target_context_id ||
    row.target_context_hash !== pin.target_context_hash ||
    row.fact_isolation_check_version !== pin.fact_isolation_check_version ||
    row.review_id !== pin.review_id ||
    row.reviewer_user_id !== pin.reviewer_user_id ||
    row.reviewer_grant_id !== pin.reviewer_grant_id ||
    row.role !== 'reference' ||
    row.deleted_at ||
    row.current_sha256.trim() !== pin.material_sha256 ||
    row.snapshot_sha256.trim() !== pin.material_sha256 ||
    row.response_status === 'failed' ||
    row.snapshot_response_sha256.trim() !== pin.parse_response_sha256 ||
    row.response_schema_version !== 'document-parse-response-v1' ||
    row.record_count < 1
  )
    return { status: 'needs_review', reason: 'pin_stale' };
  const materials = Array.isArray(input.manifest.materials) ? input.manifest.materials : [];
  if (
    !materials.some(
      (item: Record<string, unknown>) =>
        item.material_id === pin.material_id &&
        item.material_version === pin.material_version &&
        item.role === 'reference' &&
        item.sha256 === pin.material_sha256,
    )
  )
    return { status: 'needs_review', reason: 'material_not_locked' };
  if (pin.status !== 'accepted') return { status: 'needs_review', reason: `pin_${pin.status}` };
  if (
    !pin.target_context_id ||
    !pin.target_context_hash ||
    !pin.target_product ||
    !pin.target_document_stage ||
    row.context_status !== 'accepted' ||
    row.context_grant_revoked_at ||
    !row.context_reviewer_user_id ||
    !row.context_reviewer_grant_id ||
    row.context_hash?.trim() !== pin.target_context_hash ||
    inputManifestHash({
      market: row.context_market,
      offering: row.context_offering,
      product: row.context_product,
      document_stage: row.context_stage,
    }) !== pin.target_context_hash ||
    row.context_market !== pin.target_market ||
    row.context_offering !== pin.target_offering ||
    row.context_product !== pin.target_product ||
    row.context_stage !== pin.target_document_stage ||
    input.manifest.market !== pin.target_market ||
    input.manifest.offering !== pin.target_offering
  )
    return { status: 'needs_review', reason: 'target_context_stale' };
  if (
    !row.review_id ||
    row.review_status !== 'accepted' ||
    row.grant_revoked_at ||
    !row.reviewer_grant_id ||
    row.review_authorization_status !== 'accepted' ||
    row.review_readability_status !== 'accepted' ||
    row.review_applicability_status !== 'accepted' ||
    row.review_sha256.trim() !== pin.material_sha256 ||
    row.review_snapshot_id !== pin.parse_snapshot_id ||
    row.review_market !== pin.target_market ||
    row.review_offering !== pin.target_offering ||
    row.review_product !== pin.target_product ||
    row.review_stage !== pin.target_document_stage ||
    row.review_isolation_version !== pin.fact_isolation_check_version ||
    row.review_reviewer_user_id !== pin.reviewer_user_id ||
    row.review_reviewer_grant_id !== pin.reviewer_grant_id ||
    !validUserReferenceOutline(row.outline) ||
    JSON.stringify(row.outline) !== JSON.stringify(row.review_outline) ||
    row.review_outline_sha256?.trim() !== inputManifestHash(row.review_outline) ||
    row.review_parse_response_sha256?.trim() !== pin.parse_response_sha256 ||
    !userReferenceParseReviewAccepted(row, row.review_warning_codes)
  )
    return { status: 'needs_review', reason: 'review_stale' };
  return {
    status: 'accepted',
    outline: {
      schema_version: 'user-reference-outline-v1',
      owner_user_id: scope.ownerUserId,
      project_id: scope.projectId,
      run_id: scope.runId,
      input_revision: scope.inputRevision,
      input_hash: scope.inputHash,
      material_id: pin.material_id,
      material_version: pin.material_version,
      material_sha256: pin.material_sha256,
      parse_snapshot_id: pin.parse_snapshot_id,
      review_id: pin.review_id!,
      fact_isolation_check_version: pin.fact_isolation_check_version!,
      chapters: row.outline,
    },
  };
}
