/** Safe upload-inspection details for the public Error.field_errors material_upload entry. */
export const UPLOAD_INSPECTION_PUBLIC_REASONS = [
  'external_link_invalid',
  'inspection_queue_timeout',
  'inspection_timeout',
  'inspection_worker_failed',
  'size_limit',
  'encrypted_content',
  'content_mismatch',
  'unsupported_content',
  'file_size_mismatch',
  'structure_invalid',
] as const;

export type UploadInspectionPublicReason = typeof UPLOAD_INSPECTION_PUBLIC_REASONS[number];

/** Scoped upload bytes are still arriving; no material or confirmation was accepted. */
export const UPLOAD_BYTES_PENDING_FIELD_ERROR = { field: 'upload_session', code: 'bytes_pending' } as const;
export function isUploadBytesPendingFieldError(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).field === UPLOAD_BYTES_PENDING_FIELD_ERROR.field
    && (value as Record<string, unknown>).code === UPLOAD_BYTES_PENDING_FIELD_ERROR.code;
}

export function isUploadInspectionPublicReason(value: unknown): value is UploadInspectionPublicReason {
  return typeof value === 'string' && UPLOAD_INSPECTION_PUBLIC_REASONS.some(reason => reason === value);
}
