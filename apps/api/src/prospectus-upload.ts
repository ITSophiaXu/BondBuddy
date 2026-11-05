import { isWordOnlyProspectusUpload, M1_UPLOAD_MIME_TYPES, PROSPECTUS_DOCX_ONLY_MESSAGE } from '@bondbuddy/contracts';
import { Problem } from './data.js';

/** Enforce the project policy before reserving, transferring or completing a new upload. */
export function assertProspectusUploadFormat(kind: string, role: string, filename: string, mediaType: string): void {
  if (isWordOnlyProspectusUpload(kind, role) &&
      (mediaType !== M1_UPLOAD_MIME_TYPES[0] || !/\.docx$/i.test(filename))) {
    throw Object.assign(new Problem(422, 'MATERIAL_FORMAT_UNSUPPORTED', PROSPECTUS_DOCX_ONLY_MESSAGE),
      { prospectusDocxOnly: true });
  }
}
