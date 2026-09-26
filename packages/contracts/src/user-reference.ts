/** Internal structural-reference handoff. No reference issuer facts or body text cross it. */
export const USER_REFERENCE_STATUSES = ['needs_review', 'accepted', 'rejected'] as const;
export type UserReferenceStatus = typeof USER_REFERENCE_STATUSES[number];

export interface UserReferencePin {
  readonly schema_version: 'user-reference-pin-v1';
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly parse_snapshot_id: string;
  readonly status: UserReferenceStatus;
  readonly authorization_status: UserReferenceStatus;
  readonly readability_status: UserReferenceStatus;
  readonly applicability_status: UserReferenceStatus;
  readonly target_market: string;
  readonly target_offering: string;
  readonly target_product: string;
  readonly target_document_stage: string;
  readonly fact_isolation_check_version: string | null;
  readonly review_id: string | null;
  readonly reviewer_user_id: string | null;
  readonly reviewer_grant_id: string | null;
}

export interface UserReferenceOutline {
  readonly schema_version: 'user-reference-outline-v1';
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly input_revision: number;
  readonly input_hash: string;
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly parse_snapshot_id: string;
  readonly review_id: string;
  readonly fact_isolation_check_version: string;
  readonly chapters: readonly { readonly order: number; readonly heading: string }[];
}
