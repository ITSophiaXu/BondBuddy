/** Bounded independent work, with stable result order and no detached operations.
 * A rejected/uncertain item closes new admission; already accepted work settles. */
export async function boundedItems(items, limit, signal, run, continueAfter) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4)
        throw Error('INVALID_BATCH_PARALLELISM');
    const results = new Array(items.length).fill(undefined);
    let next = 0, closed = false;
    const errors = [];
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (!closed && next < items.length) {
            if (signal.aborted) {
                closed = true;
                errors.push(signal.reason ?? Error('ABORTED'));
                break;
            }
            const index = next++;
            try {
                const result = await run(items[index], index);
                results[index] = result;
                if (!continueAfter(result))
                    closed = true;
            }
            catch (error) {
                closed = true;
                errors.push(error);
            }
        }
    }));
    if (errors.length)
        throw errors[0];
    return results;
}
