import type { PoolClient } from 'pg';
import type { UserReferencePin } from '@bondbuddy/contracts';
import { Problem } from './data.js';

export interface UserReferenceChoice {
  material_id: string;
  material_version: number;
  material_sha256: string;
  parse_snapshot_id: string;
  target_product: string;
  target_document_stage: string;
}

type Scope = { owner: string; projectId: string; revision: number; market: string; offering: string };
const invalid = (message: string) => new Problem(422, 'VALIDATION_FAILED', message);

function validOutline(value: unknown): value is { order: number; heading: string }[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 120 && value.every((chapter, index) =>
    chapter && typeof chapter === 'object' && !Array.isArray(chapter) &&
    Object.keys(chapter).sort().join(',') === 'heading,order' && chapter.order === index + 1 &&
    typeof chapter.heading === 'string' && chapter.heading.trim().length > 0 && chapter.heading.length <= 200 &&
    !/[\r\n\u0000-\u001f]/.test(chapter.heading));
}

/** Called inside the same transaction that creates the immutable input revision. */
export async function resolveUserReferencePin(client: PoolClient, scope: Scope, choice: UserReferenceChoice,
  materials: readonly { material_id: string; material_version: number; role: string; sha256: string }[]): Promise<{ pin: UserReferencePin; outline: { order: number; heading: string }[] }> {
  const selected = materials.find(row => row.material_id === choice.material_id && row.material_version === choice.material_version);
  if (!selected || selected.role !== 'reference') throw invalid('Selected reference must be a locked reference material');
  if (selected.sha256 !== choice.material_sha256) throw invalid('Reference material hash mismatch');
  const snapshot = (await client.query(`SELECT id,content_sha256,response_status,response_schema_version,record_count
    FROM bb_parse_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND id=$5 FOR SHARE`,
    [scope.owner, scope.projectId, choice.material_id, choice.material_version, choice.parse_snapshot_id])).rows[0];
  if (!snapshot || snapshot.content_sha256.trim() !== selected.sha256 || snapshot.response_status !== 'parsed' ||
      snapshot.response_schema_version !== 'document-parse-response-v1' || snapshot.record_count < 1)
    throw invalid('Selected reference has no matching parsed snapshot');
  const review = (await client.query(`SELECT r.*,g.revoked_at FROM bb_user_reference_reviews r
    JOIN bb_user_reference_reviewer_grants g ON g.id=r.reviewer_grant_id AND g.reviewer_user_id=r.reviewer_user_id
    WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.material_id=$3 AND r.material_version=$4
      AND r.parse_snapshot_id=$5 ORDER BY r.created_at DESC,r.id DESC LIMIT 1 FOR SHARE OF r,g`,
    [scope.owner, scope.projectId, choice.material_id, choice.material_version, choice.parse_snapshot_id])).rows[0];
  const matches = review && !review.revoked_at && review.material_sha256.trim() === selected.sha256 &&
    review.target_market === scope.market && review.target_offering === scope.offering &&
    review.target_product === choice.target_product && review.target_document_stage === choice.target_document_stage;
  const accepted = matches && review.status === 'accepted' && review.authorization_status === 'accepted' &&
    review.readability_status === 'accepted' && review.applicability_status === 'accepted' &&
    !!review.fact_isolation_check_version?.trim() && validOutline(review.outline);
  const status = accepted ? 'accepted' : matches && review.status === 'rejected' ? 'rejected' : 'needs_review';
  const pin: UserReferencePin = {
    schema_version: 'user-reference-pin-v1', material_id: choice.material_id, material_version: choice.material_version,
    material_sha256: selected.sha256, parse_snapshot_id: choice.parse_snapshot_id, status,
    authorization_status: matches ? review.authorization_status : 'needs_review',
    readability_status: matches ? review.readability_status : 'needs_review',
    applicability_status: matches ? review.applicability_status : 'needs_review',
    target_market: scope.market, target_offering: scope.offering, target_product: choice.target_product,
    target_document_stage: choice.target_document_stage,
    fact_isolation_check_version: matches ? review.fact_isolation_check_version : null,
    review_id: matches ? review.id : null, reviewer_user_id: matches ? review.reviewer_user_id : null,
    reviewer_grant_id: matches ? review.reviewer_grant_id : null,
  };
  return { pin, outline: accepted ? review.outline : [] };
}

export async function insertUserReferencePin(client: PoolClient, scope: Scope, pin: UserReferencePin,
  outline: readonly { order: number; heading: string }[]): Promise<void> {
  await client.query(`INSERT INTO bb_user_reference_pins(owner_user_id,project_id,input_revision,material_id,material_version,
    material_sha256,parse_snapshot_id,status,authorization_status,readability_status,applicability_status,
    target_market,target_offering,target_product,target_document_stage,fact_isolation_check_version,
    review_id,reviewer_user_id,reviewer_grant_id,outline)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [scope.owner,scope.projectId,scope.revision,pin.material_id,pin.material_version,pin.material_sha256,pin.parse_snapshot_id,
      pin.status,pin.authorization_status,pin.readability_status,pin.applicability_status,pin.target_market,pin.target_offering,
      pin.target_product,pin.target_document_stage,pin.fact_isolation_check_version,pin.review_id,pin.reviewer_user_id,
      pin.reviewer_grant_id,JSON.stringify(outline)]);
}
