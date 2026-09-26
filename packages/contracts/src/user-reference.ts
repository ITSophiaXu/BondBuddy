/** Internal structural-reference handoff. No reference issuer facts or body text cross it. */
export const USER_REFERENCE_STATUSES = ['needs_review', 'accepted', 'rejected'] as const;
export type UserReferenceStatus = typeof USER_REFERENCE_STATUSES[number];
/** Parser 1.0.6 warnings that leave the extracted DOCX body structure intact. */
export const USER_REFERENCE_REVIEWABLE_WARNINGS = ['DOCX_AUXILIARY_PARTS', 'DOCX_DRAWINGS'] as const;

export function validUserReferenceOutline(value: unknown): value is { order: number; heading: string }[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 120 && value.every((chapter, index) =>
    chapter && typeof chapter === 'object' && !Array.isArray(chapter) &&
    Object.keys(chapter).sort().join(',') === 'heading,order' && chapter.order === index + 1 &&
    typeof chapter.heading === 'string' && chapter.heading.trim().length > 0 && chapter.heading.length <= 200 &&
    !/[\r\n\u0000-\u001f]/.test(chapter.heading));
}

/** Both lock and runtime use this exact parse/reviewer evidence gate. */
export function userReferenceParseReviewAccepted(snapshot: {
  response_status: unknown; response_schema_version: unknown; record_count: unknown; response_meta: unknown;
  evidence_count: unknown; uncertain_count: unknown;
}, confirmedWarningCodes: unknown): boolean {
  if (snapshot.response_schema_version !== 'document-parse-response-v1' ||
      typeof snapshot.record_count !== 'number' || snapshot.record_count < 1 ||
      Number(snapshot.evidence_count) !== snapshot.record_count || Number(snapshot.uncertain_count) !== 0 ||
      !snapshot.response_meta || typeof snapshot.response_meta !== 'object' || Array.isArray(snapshot.response_meta)) return false;
  const meta = snapshot.response_meta as Record<string, unknown>;
  const document = meta.document;
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      (document as Record<string, unknown>).coverage === 'incomplete' || meta.coverage === 'incomplete') return false;
  if (!Array.isArray(meta.warnings) || !Array.isArray(confirmedWarningCodes)) return false;
  const codes = meta.warnings.map(warning => warning && typeof warning === 'object' && !Array.isArray(warning)
    ? (warning as Record<string, unknown>).code : null);
  if (codes.some(code => typeof code !== 'string') ||
      new Set(codes).size !== codes.length || new Set(confirmedWarningCodes).size !== confirmedWarningCodes.length ||
      confirmedWarningCodes.some(code => typeof code !== 'string')) return false;
  const exact = [...codes].sort().join('\u0000') === [...confirmedWarningCodes].sort().join('\u0000');
  if (!exact) return false;
  if (snapshot.response_status === 'parsed') return codes.length === 0;
  return snapshot.response_status === 'needs_confirmation' && codes.length > 0 &&
    meta.material !== null && typeof meta.material === 'object' &&
    (meta.material as Record<string, unknown>).media_type ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    codes.every(code => USER_REFERENCE_REVIEWABLE_WARNINGS.includes(code as typeof USER_REFERENCE_REVIEWABLE_WARNINGS[number]));
}

export interface UserReferencePin {
  readonly schema_version: 'user-reference-pin-v1';
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly parse_snapshot_id: string;
  readonly parse_response_sha256: string;
  readonly status: UserReferenceStatus;
  readonly authorization_status: UserReferenceStatus;
  readonly readability_status: UserReferenceStatus;
  readonly applicability_status: UserReferenceStatus;
  readonly target_market: string;
  readonly target_offering: string;
  readonly target_product: string | null;
  readonly target_document_stage: string | null;
  readonly target_context_id: string | null;
  readonly target_context_hash: string | null;
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
