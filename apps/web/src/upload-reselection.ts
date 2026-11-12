import type { UploadRecoveryRecord } from './upload-recovery.js';
import { DIRECT_UPLOAD_TRANSPORT } from '@bondbuddy/contracts';

/** Offering a picker never authorizes replacement: resume still checks the
 * selected bytes, old upload receipt and exact bytes-pending response. */
export function canReselectExpiredUpload(record: UploadRecoveryRecord, now = Date.now()): boolean {
  return !record.material && record.stage === 'bytes_unknown' && record.uploadTransport !== DIRECT_UPLOAD_TRANSPORT &&
    !!record.uploadId && !!record.expiresAt && Date.parse(record.expiresAt) <= now;
}
