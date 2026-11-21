import { UserFacingError } from './user-facing-error.js';

export type ArtifactDownloadPhase = 'metadata' | 'headers' | 'body' | 'assembly' | 'hash';
export type ArtifactDownloadPolicy = { totalMs: number; metadataMs: number; headersMs: number; bodyIdleMs: number; assemblyMs: number; hashMs: number };
export const ARTIFACT_DOWNLOAD_POLICY: Readonly<ArtifactDownloadPolicy> = Object.freeze({
  totalMs: 15 * 60_000, metadataMs: 120_000, headersMs: 120_000,
  bodyIdleMs: 120_000, assemblyMs: 30_000, hashMs: 30_000,
});

export class ArtifactDownloadTimeout extends UserFacingError {
  constructor(readonly phase: ArtifactDownloadPhase, readonly kind: 'stage' | 'idle' | 'total') {
    super('下载准备超时，请重试下载。已保存文件仍保留，无需重新生成。');
  }
}

export type ArtifactDownloadSnapshot = {
  phase: ArtifactDownloadPhase; received_bytes: number; elapsed_ms: number;
  completed: ArtifactDownloadPhase[]; request_ids: Partial<Record<'metadata' | 'headers', string>>;
};
export type ArtifactDownloadLifecycle = {
  signal: AbortSignal;
  stage<T>(phase: ArtifactDownloadPhase, work: () => Promise<T>): Promise<T>;
  progress(received: number): void;
  request(phase: 'metadata' | 'headers', requestId: string | null): void;
  snapshot(): ArtifactDownloadSnapshot;
};

export type ArtifactDownloadHandoffEvent = 'auto_save_requested' | 'save_link_clicked' | 'handoff_failed';
const handoffObservers = new WeakMap<Blob, (event: ArtifactDownloadHandoffEvent) => void>();
export function observeArtifactHandoff(bytes: Blob, observer: (event: ArtifactDownloadHandoffEvent) => void) { handoffObservers.set(bytes, observer); }
export function recordArtifactHandoff(bytes: Blob, event: ArtifactDownloadHandoffEvent) {
  try { handoffObservers.get(bytes)?.(event); } catch { /* Diagnostics never change delivery. */ }
}

/** One controller and total bound, with independent stage/real-byte idle bounds. */
export async function withArtifactDownload<T>(parent: AbortSignal, work: (download: ArtifactDownloadLifecycle) => Promise<T>, options: Partial<ArtifactDownloadPolicy> = {}): Promise<T> {
  parent.throwIfAborted();
  const policy = { ...ARTIFACT_DOWNLOAD_POLICY, ...options };
  if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) throw new RangeError('Invalid download deadline');
  const controller = new AbortController(), started = performance.now();
  let phase: ArtifactDownloadPhase = 'metadata', received = 0;
  const completed: ArtifactDownloadPhase[] = [], requestIds: ArtifactDownloadSnapshot['request_ids'] = {};
  let stageTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort(parent.reason);
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  parent.addEventListener('abort', cancel, { once: true });
  if (parent.aborted) cancel();
  const totalTimer = setTimeout(() => controller.abort(new ArtifactDownloadTimeout(phase, 'total')), policy.totalMs);
  const armStage = () => {
    clearTimeout(stageTimer);
    const timeout = phase === 'body' ? policy.bodyIdleMs : policy[`${phase}Ms`];
    stageTimer = setTimeout(() => controller.abort(new ArtifactDownloadTimeout(phase, phase === 'body' ? 'idle' : 'stage')), timeout);
  };
  const download: ArtifactDownloadLifecycle = {
    signal: controller.signal,
    async stage(next, run) {
      controller.signal.throwIfAborted();
      phase = next; armStage();
      try {
        const value = await Promise.race([run(), interrupted]);
        controller.signal.throwIfAborted();
        completed.push(next);
        return value;
      } finally { clearTimeout(stageTimer); }
    },
    progress(value) {
      if (phase === 'body' && Number.isSafeInteger(value) && value > received && !controller.signal.aborted) {
        received = value; armStage();
      }
    },
    request(next, id) { if (id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) requestIds[next] = id; },
    snapshot: () => ({ phase, received_bytes: received, elapsed_ms: Math.max(0, Math.round(performance.now() - started)), completed: [...completed], request_ids: { ...requestIds } }),
  };
  try { return await Promise.race([work(download), interrupted]); }
  catch (error) { controller.abort(error); throw error; }
  finally { clearTimeout(totalTimer); clearTimeout(stageTimer); parent.removeEventListener('abort', cancel); }
}

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
