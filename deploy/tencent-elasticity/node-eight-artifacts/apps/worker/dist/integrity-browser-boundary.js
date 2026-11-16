/** Playwright's transport invokes its async CDP callback without awaiting it.
 * A late unmatched reply can therefore reject outside the collector's try/catch.
 * Fence every concurrent collection when the protocol cannot identify its owner;
 * no partial capture is accepted as a completed official query. */
const active = new Set();
export function isIntegrityProtocolRejection(reason) {
    const stack = reason instanceof Error ? reason.stack ?? '' : '';
    return /playwright-core\/lib\/coreBundle\.js/.test(stack) && /\bat assert /.test(stack) &&
        /\bat _CRSession\._onMessage /.test(stack) && /\bat CRConnection\._onMessage /.test(stack);
}
const onRejection = (reason) => {
    if (isIntegrityProtocolRejection(reason) && active.size) {
        for (const stop of [...active])
            stop(new Error('INTEGRITY_BROWSER_RUNTIME_FAILED'));
        return;
    }
    // Retain fail-fast behavior for all unrelated unhandled failures.
    queueMicrotask(() => { throw reason; });
};
export async function integrityBrowserBoundary(signal, run) {
    const controller = new AbortController();
    let failure;
    const stop = (reason) => { failure = reason; controller.abort(reason); };
    if (!active.size)
        process.on('unhandledRejection', onRejection);
    active.add(stop);
    try {
        const result = await run(AbortSignal.any([signal, controller.signal]));
        if (failure)
            throw failure;
        return result;
    }
    catch (error) {
        throw failure ?? error;
    }
    finally {
        active.delete(stop);
        if (!active.size)
            process.removeListener('unhandledRejection', onRejection);
    }
}
