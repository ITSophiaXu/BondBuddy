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
// A ~96 MiB scanned PDF takes ~14 s to inspect on the 0.75-CPU api container.
const INSPECTION_TIMEOUT_MS = 45_000;
// Single-flight: one parser worker per API process (a scanned PDF alone needs ~300 MiB). Further
// inspections wait in FIFO order for a bounded time, then fail with a stable retryable 503.
const MAX_CONCURRENT_INSPECTIONS = 1;
const STREAMED_MEDIA_TYPES = new Set(['text/plain', 'text/csv']);

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
        reject(new UploadSafetyError(503, 'DATA_UNAVAILABLE', 'Material inspection capacity is temporarily busy'));
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
  if (!Number.isInteger(bytes.length) || bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material exceeds the inspection limit');
  }
  const release = await acquireInspection();
  try {
    // The input copy is bounded by the 100 MiB upload limit and is transferred, not cloned.
    const ownedBytes = Uint8Array.from(bytes);
    return await runInspectionWorker({ bytes: ownedBytes.buffer, mediaType }, [ownedBytes.buffer], mediaType, 192);
  } finally {
    release();
  }
}

/** Inspect a spooled upload from disk. Text/CSV are streamed; other formats are read once inside the worker. */
export async function inspectMaterialUploadFile(path: string, byteSize: number, mediaType: string): Promise<UploadMediaType> {
  if (!Number.isInteger(byteSize) || byteSize < 1 || byteSize > MAX_UPLOAD_BYTES) {
    throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Material exceeds the inspection limit');
  }
  const release = await acquireInspection();
  try {
    return await runInspectionWorker({ path, byteSize, mediaType }, [], mediaType, STREAMED_MEDIA_TYPES.has(mediaType) ? 32 : 192);
  } finally {
    release();
  }
}

async function runInspectionWorker(workerData: Record<string, unknown>, transferList: ArrayBuffer[], mediaType: string, heapMb: number): Promise<UploadMediaType> {
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
}
