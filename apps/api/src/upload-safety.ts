import { Worker } from 'node:worker_threads';
import type { ErrorCode, UploadMediaType } from '@bondbuddy/contracts';

export type UploadSafetyCode = Extract<ErrorCode, `MATERIAL_${string}` | 'DATA_UNAVAILABLE'>;
export type UploadWorkerReply =
  | { ok: true }
  | { ok: false; status: 415 | 422; code: Exclude<UploadSafetyCode, 'DATA_UNAVAILABLE'>; message: string };

export class UploadSafetyError extends Error {
  constructor(public readonly status: 415 | 422 | 503, public readonly code: UploadSafetyCode, message: string) {
    super(message);
  }
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const INSPECTION_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_INSPECTIONS = 2;
let activeInspections = 0;

export async function inspectMaterialUpload(bytes: Buffer, mediaType: string): Promise<UploadMediaType> {
  if (!Number.isInteger(bytes.length) || bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material exceeds the inspection limit');
  }
  if (activeInspections >= MAX_CONCURRENT_INSPECTIONS) {
    throw new UploadSafetyError(503, 'DATA_UNAVAILABLE', 'Material inspection capacity is temporarily busy');
  }
  activeInspections++;

  try {
    // Give the parser its own bounded worker so malformed streams cannot block Fastify's event loop.
    // The input copy is bounded by the existing 100 MiB request limit and is transferred, not cloned.
    const ownedBytes = Uint8Array.from(bytes);
    let worker: Worker;
    try {
      worker = new Worker(new URL('./upload-inspection-worker.js', import.meta.url), {
        workerData: { bytes: ownedBytes.buffer, mediaType },
        transferList: [ownedBytes.buffer],
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4
        }
      });
    } catch {
      throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material could not be safely inspected');
    }

    return await new Promise<UploadMediaType>((resolve, reject) => {
      let settled = false;
      const finish = async (error?: UploadSafetyError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { await worker.terminate(); } catch { /* Releasing the parser slot still fails closed. */ }
        if (error) reject(error);
        else resolve(mediaType as UploadMediaType);
      };
      const timer = setTimeout(() => {
        finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material inspection exceeded its time limit'));
      }, INSPECTION_TIMEOUT_MS);

      worker.once('message', (reply: UploadWorkerReply) => {
        if (reply?.ok === true) return finish();
        if (reply?.ok === false && (reply.status === 415 || reply.status === 422)) {
          return finish(new UploadSafetyError(reply.status, reply.code, reply.message));
        }
        finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material could not be safely inspected'));
      });
      worker.once('error', () => finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material could not be safely inspected')));
      worker.once('exit', code => {
        if (!settled && code !== 0) finish(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material could not be safely inspected'));
      });
    });
  } finally {
    activeInspections--;
  }
}
