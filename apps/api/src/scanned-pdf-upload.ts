import { Worker } from 'node:worker_threads';
import { UploadSafetyError } from './upload-safety.js';

let pending: Promise<void> = Promise.resolve();
const TIMEOUT_MS = 45_000;

/** One bounded parser at a time; a malformed PDF cannot block the API event loop. */
export async function assertElectronicPdf(path: string): Promise<void> {
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const previous = pending;
  pending = next;
  let acquired = false;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => { queueTimer = setTimeout(() => reject(new UploadSafetyError(503, 'DATA_UNAVAILABLE', 'PDF inspection queue is busy', 'inspection_queue_timeout')), 60_000); })
    ]);
    acquired = true;
    clearTimeout(queueTimer);
    const outcome = await new Promise<'scanned' | 'electronic'>((resolve, reject) => {
      const worker = new Worker(new URL('./scanned-pdf-worker.js', import.meta.url), {
        workerData: { path },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
      });
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new UploadSafetyError(503, 'DATA_UNAVAILABLE', 'PDF inspection timed out', 'inspection_timeout'));
      }, TIMEOUT_MS);
      worker.once('message', (message: { scanned?: boolean; failed?: boolean }) => {
        clearTimeout(timeout);
        void worker.terminate();
        if (message.failed) reject(new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'PDF could not be inspected', 'structure_invalid'));
        else resolve(message.scanned ? 'scanned' : 'electronic');
      });
      worker.once('error', () => {
        clearTimeout(timeout);
        reject(new UploadSafetyError(503, 'DATA_UNAVAILABLE', 'PDF inspection failed', 'inspection_worker_failed'));
      });
      worker.once('exit', code => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new UploadSafetyError(503, 'DATA_UNAVAILABLE', 'PDF inspection failed', 'inspection_worker_failed'));
        }
      });
    });
    if (outcome === 'scanned') throw new UploadSafetyError(422, 'MATERIAL_UNREADABLE', 'Scanned PDF is not accepted', 'scanned_pdf');
  } finally {
    clearTimeout(queueTimer);
    if (acquired) release();
    else void previous.then(release);
  }
}
