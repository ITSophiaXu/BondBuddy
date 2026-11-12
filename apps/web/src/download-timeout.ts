import { UserFacingError } from './user-facing-error.js';

/** Include headers and the whole body; even a stalled reader must release its caller. */
export async function boundedDownload<T>(parent: AbortSignal, read: (signal: AbortSignal) => Promise<T>, timeoutMs = 120_000): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(parent.reason);
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  parent.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await Promise.race([read(controller.signal), interrupted]);
  } catch (error) {
    if (timedOut && !parent.aborted) throw new UserFacingError('下载准备超时，请重试下载。已保存文件仍保留，无需重新生成。');
    throw error;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', cancel);
  }
}
