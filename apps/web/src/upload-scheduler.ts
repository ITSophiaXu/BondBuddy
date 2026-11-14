/** Keep transport capacity separate from the slower server confirmation. */
export const UPLOAD_WINDOW_SIZE = 4;
export class UploadTransferQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit = UPLOAD_WINDOW_SIZE) {
    if (!Number.isInteger(limit) || limit < 1 || limit > UPLOAD_WINDOW_SIZE) throw new RangeError('Invalid upload limit');
  }
  run<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const abort = () => {
        if (started) return;
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      const start = () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { reject(signal.reason); this.pump(); return; }
        started = true; this.active++;
        // Start immediately when capacity is free, as uploadBytes did before.
        let result: Promise<T>;
        try { result = action(); } catch (error) { result = Promise.reject(error); }
        const release = () => { this.active--; this.pump(); };
        void result.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
      };
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(start); this.pump();
    });
  }
  private pump() { while (this.active < this.limit && this.waiting.length) this.waiting.shift()!(); }
}

/** All ApiClient instances in this page share the same four actual PUT slots. */
export const uploadTransfers = new UploadTransferQueue();

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
export class UploadPreparationError extends Error {
  constructor(public readonly index: number, public readonly original: unknown) { super('Upload preparation failed', { cause: original }); }
}
/** Upload a bounded look-ahead window; apply business changes only in selection order.
 * A failed/stopped item cancels its batch's pending work but leaves recovery records intact. */
export async function orderedUploadPipeline<T, R>(
  items: readonly T[], prepare: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  consume: (value: R, item: T, index: number) => Promise<boolean | void>,
  signal: AbortSignal, windowSize = UPLOAD_WINDOW_SIZE,
): Promise<boolean> {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new RangeError('Invalid upload window');
  const controller = new AbortController(), lifetime = AbortSignal.any([signal, controller.signal]);
  const pending = new Map<number, Promise<Settled<R>>>();
  let next = 0, failed = false;
  const fill = (index: number) => {
    while (!failed && !lifetime.aborted && next < items.length && next < index + windowSize) {
      const current = next++;
      pending.set(current, Promise.resolve().then(() => {
        lifetime.throwIfAborted(); return prepare(items[current], current, lifetime);
      }).then<Settled<R>, Settled<R>>(value => ({ ok: true, value }), error => { failed = true; return { ok: false, error }; }));
    }
  };
  try {
    fill(0);
    for (let index = 0; index < items.length; index++) {
      lifetime.throwIfAborted();
      const result = await pending.get(index)!;
      lifetime.throwIfAborted();
      if (!result.ok) throw new UploadPreparationError(index, result.error);
      if (await consume(result.value, items[index], index) === false) return false;
      pending.delete(index); fill(index + 1);
    }
    return true;
  } finally {
    controller.abort();
    // Let aborted transports release their recovery locks before retry controls return.
    await Promise.all(pending.values());
  }
}
