/** Pull ready work only up to the current resource window. A failure closes new
 * admission and drains every accepted sibling; results keep the input order. */
export async function boundedItems<T, R>(
  items: readonly T[],
  capacity: number | (() => Promise<number>),
  signal: AbortSignal,
  run: (item: T, index: number) => Promise<R>,
  continueAfter: (result: R) => boolean,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length).fill(undefined),
    pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let next = 0,
    closed = false;
  const close = (error: unknown) => {
    closed = true;
    errors.push(error);
  };
  do {
    if (signal.aborted && !closed) close(signal.reason ?? Error('ABORTED'));
    if (!closed && next < items.length) {
      try {
        const limit = typeof capacity === 'number' ? capacity : await capacity();
        if (!Number.isSafeInteger(limit) || limit < 1) throw Error('INVALID_BATCH_PARALLELISM');
        while (!closed && !signal.aborted && next < items.length && pending.size < limit) {
          const index = next++;
          const work = Promise.resolve()
            .then(async () => {
              if (signal.aborted) {
                close(signal.reason ?? Error('ABORTED'));
                return;
              }
              try {
                const result = await run(items[index]!, index);
                results[index] = result;
                if (!continueAfter(result)) closed = true;
              } catch (error) {
                close(error);
              }
            })
            .finally(() => {
              pending.delete(work);
            });
          pending.add(work);
        }
      } catch (error) {
        close(error);
      }
    }
    if (pending.size) await Promise.race(pending);
  } while (pending.size || (!closed && next < items.length));
  if (errors.length) throw errors[0];
  return results;
}
