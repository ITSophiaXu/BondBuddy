import { stat } from 'node:fs/promises';
import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, type UploadMediaType } from '@bondbuddy/contracts';
import { UploadSafetyError, type UploadInspectionResult } from './upload-safety.js';

// Project uploads are opaque originals. The API never opens document content;
// the explicit Codex task handles reading, OCR and content interpretation.
function declaration(byteSize: number, mediaType: string): UploadInspectionResult {
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > M1_UPLOAD_LIMITS.fileBytes)
    throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material exceeds the upload size limit', 'size_limit');
  if (!(M1_UPLOAD_MIME_TYPES as readonly string[]).includes(mediaType))
    throw new UploadSafetyError(415, 'MATERIAL_FORMAT_UNSUPPORTED', 'Declared file type is not supported', 'unsupported_content');
  return { mediaType: mediaType as UploadMediaType, signatureAssessment: null };
}

export async function inspectMaterialUpload(bytes: Buffer, mediaType: string): Promise<UploadMediaType> {
  return declaration(bytes.length, mediaType).mediaType;
}

export async function inspectMaterialUploadFile(path: string, byteSize: number, mediaType: string): Promise<UploadMediaType> {
  return (await inspectMaterialUploadFileDetailed(path, byteSize, mediaType)).mediaType;
}

export async function inspectMaterialUploadFileDetailed(path: string, byteSize: number, mediaType: string): Promise<UploadInspectionResult> {
  const result = declaration(byteSize, mediaType);
  const file = await stat(path);
  if (!file.isFile() || file.size !== byteSize)
    throw new UploadSafetyError(422, 'MATERIAL_CONTENT_MISMATCH', 'Stored file size differs from the upload', 'content_mismatch');
  return result;
}
