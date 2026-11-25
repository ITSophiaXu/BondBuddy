import { Worker } from 'node:worker_threads';
import { SignatureAssessmentSchema, type ErrorCode, type SignatureAssessment, type UploadMediaType } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';

export type UploadSafetyCode = Extract<ErrorCode, `MATERIAL_${string}` | 'DATA_UNAVAILABLE'>;
export const UPLOAD_REJECTION_REASONS = [
  'size_limit', 'inspection_queue_timeout', 'inspection_timeout', 'inspection_worker_failed',
  'archive_entry_limit', 'archive_expanded_limit', 'archive_ratio', 'xml_part_limit',
  'structure_invalid', 'unsupported_content', 'content_mismatch', 'encrypted_content', 'scanned_pdf'
] as const;
export type UploadRejectionReason = typeof UPLOAD_REJECTION_REASONS[number];
export const UPLOAD_STRUCTURE_DETAILS = [
  'text_encoding_invalid', 'csv_quote_invalid', 'zip_name_encoding_invalid', 'zip_extra_invalid',
  'zip_read_out_of_bounds', 'zip_read_incomplete', 'zip_eocd_missing', 'zip_central_bounds_invalid',
  'zip_central_record_invalid', 'zip_central_name_invalid', 'zip_directory_invalid',
  'zip_local_bounds_invalid', 'zip_local_signature_invalid', 'zip_central_local_mismatch',
  'zip_data_descriptor_mismatch', 'zip_record_gap', 'zip_expanded_size_mismatch',
  'zip_inflate_error', 'zip_crc_mismatch', 'xml_encoding_invalid', 'xml_parse_error',
  'xml_root_unexpected', 'content_types_invalid', 'part_name_invalid',
  'relationship_invalid', 'external_link_invalid', 'pdf_structure_invalid',
  'png_structure_invalid', 'png_crc_mismatch', 'jpeg_structure_invalid', 'file_size_mismatch'
] as const;
export type UploadStructureDetail = typeof UPLOAD_STRUCTURE_DETAILS[number];
export type UploadWorkerReply =
  | { ok: true; signatureAssessment: SignatureAssessment | null }
  | { ok: false; status: 415 | 422; code: Exclude<UploadSafetyCode, 'DATA_UNAVAILABLE'>; message: string; reason: UploadRejectionReason; detail?: UploadStructureDetail };

export class UploadSafetyError extends Error {
  constructor(public readonly status: 415 | 422 | 503, public readonly code: UploadSafetyCode, message: string, public readonly reason: UploadRejectionReason, public readonly detail?: UploadStructureDetail) {
    super(message);
  }
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// A ~96 MiB scanned PDF takes ~14 s to inspect on the 0.75-CPU api container.
const INSPECTION_TIMEOUT_MS = 45_000;
// Single-flight: one parser worker per API process (a scanned PDF alone needs ~300 MiB). Further
// inspections wait in FIFO order for a bounded time, then fail with a stable retryable 503.
const MAX_CONCURRENT_INSPECTIONS = 1;
const STREAMED_MEDIA_TYPES = new Set(['text/plain', 'text/csv']);
export type UploadInspectionResult = { mediaType: UploadMediaType; signatureAssessment: SignatureAssessment | null };

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

let activeInspections = 0;
const waiting: Array<() => void> = [];

async function acquireInspection(): Promise<() => void> {
  if (activeInspections < MAX_CONCURRENT_INSPECTIONS && !waiting.length) activeInspections++;
  else {
    await new Promise<void>((resolve, reject) => {
      const admit = () => { clearTimeout(timer); activeInspections++; resolve(); };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(admit), 1);
        reject(new UploadSafetyError(503, 'DATA_UNAVAILABLE', 'Material inspection capacity is temporarily busy', 'inspection_queue_timeout'));
      }, positiveEnv('BB_UPLOAD_INSPECTION_QUEUE_MS', 60_000));
      waiting.push(admit);
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeInspections--;
    waiting.shift()?.();
  };
}

export async function inspectMaterialUpload(bytes: Buffer, mediaType: string): Promise<UploadMediaType> {
  return (await inspectMaterialUploadDetailed(bytes, mediaType)).mediaType;
}

export async function inspectMaterialUploadDetailed(bytes: Buffer, mediaType: string): Promise<UploadInspectionResult> {
  if (!Number.isInteger(bytes.length) || bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material exceeds the inspection limit', 'size_limit');
  }
  const release = await acquireInspection();
  try {
    // The input copy is bounded by the 100 MiB upload limit and is transferred, not cloned.
    const ownedBytes = Uint8Array.from(bytes);
    return await runInspectionWorkerDetailed({ bytes: ownedBytes.buffer, mediaType }, [ownedBytes.buffer], mediaType, 192);
  } finally {
    release();
  }
}

/** Inspect a spooled upload from disk. Text/CSV are streamed; other formats are read once inside the worker. */
export async function inspectMaterialUploadFile(path: string, byteSize: number, mediaType: string): Promise<UploadMediaType> {
  return (await inspectMaterialUploadFileDetailed(path, byteSize, mediaType)).mediaType;
}

export async function inspectMaterialUploadFileDetailed(path: string, byteSize: number, mediaType: string): Promise<UploadInspectionResult> {
  if (!Number.isInteger(byteSize) || byteSize < 1 || byteSize > MAX_UPLOAD_BYTES) {
    throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material exceeds the inspection limit', 'size_limit');
  }
  const release = await acquireInspection();
  try {
    return await runInspectionWorkerDetailed({ path, byteSize, mediaType }, [], mediaType, STREAMED_MEDIA_TYPES.has(mediaType) ? 32 : 192);
  } finally {
    release();
  }
}

export async function runInspectionWorker(workerData: Record<string, unknown>, transferList: ArrayBuffer[], mediaType: string, heapMb: number, timeoutMs = INSPECTION_TIMEOUT_MS): Promise<UploadMediaType> {
  return (await runInspectionWorkerDetailed(workerData, transferList, mediaType, heapMb, timeoutMs)).mediaType;
}

export async function runInspectionWorkerDetailed(workerData: Record<string, unknown>, transferList: ArrayBuffer[], mediaType: string, heapMb: number, timeoutMs = INSPECTION_TIMEOUT_MS): Promise<UploadInspectionResult> {
  // Streaming the body/Blob leaves chunk buffers that V8 frees lazily; with --expose-gc (set in the
  // container) reclaim them before a parser isolate is added to a small memory limit.
  (globalThis as { gc?: () => void }).gc?.();
  // Give the parser its own bounded worker so malformed streams cannot block Fastify's event loop.
  let worker: Worker;
  try {
    worker = new Worker(new URL('./upload-inspection-worker.js', import.meta.url), {
      workerData,
      transferList,
      resourceLimits: {
        maxOldGenerationSizeMb: heapMb,
        maxYoungGenerationSizeMb: Math.min(32, heapMb / 2),
        stackSizeMb: 4
      }
    });
  } catch {
    throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material could not be safely inspected', 'inspection_worker_failed');
  }

  return await new Promise<UploadInspectionResult>((resolve, reject) => {
    let settled = false;
    const finish = async (error?: UploadSafetyError, signatureAssessment: SignatureAssessment | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { await worker.terminate(); } catch { /* Releasing the parser slot still fails closed. */ }
      if (error) reject(error);
      else resolve({ mediaType: mediaType as UploadMediaType, signatureAssessment });
    };
    const timer = setTimeout(() => {
      finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material inspection exceeded its time limit', 'inspection_timeout'));
    }, timeoutMs);

    worker.once('message', (reply: UploadWorkerReply) => {
      if (reply?.ok === true) {
        const assessment = reply.signatureAssessment;
        if (assessment === null || mediaType === 'application/pdf' && Value.Check(SignatureAssessmentSchema, assessment)) return finish(undefined, assessment);
        return finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material inspection returned an invalid assessment', 'inspection_worker_failed'));
      }
      if (reply?.ok === false && (reply.status === 415 || reply.status === 422)) {
        const reason = UPLOAD_REJECTION_REASONS.find(value => value === reply.reason);
        const detail = reason === 'structure_invalid' ? UPLOAD_STRUCTURE_DETAILS.find(value => value === reply.detail) : undefined;
        if (reason && (reason !== 'structure_invalid' || detail)) {
          return finish(new UploadSafetyError(reply.status, reply.code, reply.message, reason, detail));
        }
      }
      finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material could not be safely inspected', 'inspection_worker_failed'));
    });
    worker.once('error', () => finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material could not be safely inspected', 'inspection_worker_failed')));
    worker.once('exit', () => {
      if (!settled) finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material could not be safely inspected', 'inspection_worker_failed'));
    });
  });
}
