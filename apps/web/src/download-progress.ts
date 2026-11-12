export type DownloadProgress = (received: number, total?: number) => void;

/** Count actual response bytes. Encoded Content-Length is not a decoded total. */
export async function readDownloadBytes(response: Response, signal: AbortSignal, progress?: DownloadProgress): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  if (!response.body) return response.arrayBuffer();
  const length = Number(response.headers.get('content-length'));
  const encoding = response.headers.get('content-encoding');
  const total = (!encoding || encoding === 'identity') && Number.isSafeInteger(length) && length > 0 ? length : undefined;
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, {once:true});
  let received = 0;
  progress?.(0, total);
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(new Uint8Array(value)); received += value.byteLength;
      progress?.(received, total && received <= total ? total : undefined);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  return new Blob(chunks).arrayBuffer();
}

export function downloadProgressText(received: number, total?: number): string {
  const size = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
  return total ? `正在下载… ${Math.floor(received / total * 100)}%（${size(received)} / ${size(total)}）` : `正在下载… 已接收 ${size(received)}`;
}
