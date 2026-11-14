import {sha256} from '@noble/hashes/sha2.js';
import {M1_UPLOAD_LIMITS} from '@bondbuddy/contracts';
import {UploadTransferQueue} from './upload-scheduler.js';

export const UPLOAD_HASH_CHUNK_BYTES = 1024 * 1024;
// Shared by every upload entry in this page, independent of the four PUT slots.
const hashing = new UploadTransferQueue(1);
const lifetime = new AbortController().signal;

/** Hash original bytes without retaining a whole large file or four parallel copies. */
export function uploadFileDigest(file: Blob, signal: AbortSignal = lifetime): Promise<Uint8Array> {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > M1_UPLOAD_LIMITS.fileBytes)
    return Promise.reject(new RangeError('Invalid upload file size'));
  return hashing.run(async () => {
    const hash = sha256.create();
    try {
      for (let offset = 0; offset < file.size; offset += UPLOAD_HASH_CHUNK_BYTES) {
        signal.throwIfAborted();
        const bytes = new Uint8Array(await file.slice(offset, offset + UPLOAD_HASH_CHUNK_BYTES).arrayBuffer());
        signal.throwIfAborted();
        hash.update(bytes);
        // Yield to cancellation/painting between bounded CPU work units.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      signal.throwIfAborted();
      return hash.digest();
    } finally { hash.destroy(); }
  }, signal);
}

export async function uploadFileSha256(file: Blob, signal?: AbortSignal): Promise<string> {
  return [...await uploadFileDigest(file, signal)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
