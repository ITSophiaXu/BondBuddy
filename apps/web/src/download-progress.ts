import type { ArtifactDownloadLifecycle } from './download-timeout.js';

export type DownloadProgress = (received: number, total?: number) => void;

/** Count actual response bytes. Encoded Content-Length is not a decoded total. */
export async function readDownloadBytes(response: Response, signal: AbortSignal, progress?: DownloadProgress, lifecycle?: ArtifactDownloadLifecycle): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  if (!response.body) {
    const read = async () => { const bytes = await response.arrayBuffer(); signal.throwIfAborted(); lifecycle?.progress(bytes.byteLength); return bytes; };
    const bytes = lifecycle ? await lifecycle.stage('body', read) : await read();
    signal.throwIfAborted(); return bytes;
  }
  const length = Number(response.headers.get('content-length'));
  const encoding = response.headers.get('content-encoding');
  const total = (!encoding || encoding === 'identity') && Number.isSafeInteger(length) && length > 0 ? length : undefined;
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, {once:true});
  if (signal.aborted) cancel();
  let received = 0;
  const read = async () => {
    signal.throwIfAborted(); progress?.(0, total);
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(new Uint8Array(value)); received += value.byteLength;
      lifecycle?.progress(received);
      progress?.(received, total && received <= total ? total : undefined);
    }
  };
  try { if (lifecycle) await lifecycle.stage('body', read); else await read(); }
  catch (error) { void reader.cancel(error).catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const assemble = () => new Blob(chunks).arrayBuffer();
  return lifecycle ? lifecycle.stage('assembly', assemble) : assemble();
}

export function downloadProgressText(received: number, total?: number): string {
  const size = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
  return total ? `正在下载… ${Math.floor(received / total * 100)}%（${size(received)} / ${size(total)}）` : `正在下载… 已接收 ${size(received)}`;
}
