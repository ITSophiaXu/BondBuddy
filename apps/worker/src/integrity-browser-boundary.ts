import { createHash } from 'node:crypto';

export type IntegrityBrowserPhase = 'proxy' | 'desktop' | 'launch' | 'context' | 'cleanup';
class BrowserOperationError extends Error {
  readonly phase: IntegrityBrowserPhase;
  constructor(phase: IntegrityBrowserPhase, cause: unknown) {
    // Preserve the collector's existing safe public code; private diagnostics add
    // context without changing a native-desktop/configuration failure's label.
    const code =
      cause instanceof Error &&
      /^(?:INTEGRITY_[A-Z_]+|INVALID_INTEGRITY_EGRESS_PROXY|E[A-Z]+)$/.test(cause.message)
        ? cause.message
        : 'INTEGRITY_BROWSER_RUNTIME_FAILED';
    super(code, { cause });
    this.phase = phase;
  }
}
const browserErrnos = new Set([
  'EACCES',
  'EADDRINUSE',
  'EAGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EIO',
  'EMFILE',
  'ENETUNREACH',
  'ENFILE',
  'ENOENT',
  'ENOMEM',
  'ENOSPC',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
]);
export async function integrityBrowserOperation<T>(
  phase: IntegrityBrowserPhase,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new BrowserOperationError(phase, error);
  }
}
/** Durable private batch diagnostics: never persist raw browser messages, URLs,
 * command lines, environment, user queries or credentials from the stack. */
export function integrityBrowserFailure(error: unknown) {
  const chain: Error[] = [];
  let next = error;
  while (next instanceof Error && chain.length < 4 && !chain.includes(next)) {
    chain.push(next);
    next = next.cause;
  }
  const stack = chain.map((e) => e.stack ?? e.name).join('\n'),
    messages = chain.map((e) => e.message).join('\n');
  const code = chain
    .map((e) => (e as NodeJS.ErrnoException).code)
    .find((c) => typeof c === 'string' && browserErrnos.has(c));
  const kind = chain.some(isIntegrityProtocolRejection)
    ? 'cdp_protocol'
    : /Executable doesn't exist/.test(messages)
      ? 'browser_binary_missing'
      : /sandbox|Operation not permitted/i.test(messages)
        ? 'sandbox'
        : /INTEGRITY_NATIVE_/.test(messages)
          ? 'native_desktop'
          : code === 'ENOMEM' || code === 'EAGAIN'
            ? 'resource_limit'
            : /browserType\.launch|Target.*closed/.test(messages)
              ? 'browser_closed'
              : 'operation_failed';
  const frames = [
    ...stack.matchAll(
      /(?:^|\/)((?:coreBundle|integrity-browser|integrity-desktop|integrity-browser-network|integrity-browser-boundary)\.(?:js|ts):\d+:\d+)/gm,
    ),
  ]
    .map((m) => m[1])
    .slice(0, 8);
  return {
    version: 'browser-failure-v1' as const,
    phase: chain.find((e) => e instanceof BrowserOperationError)?.phase ?? 'unknown',
    kind,
    ...(code ? { code } : {}),
    frames,
    fingerprint: createHash('sha256').update(stack).digest('hex'),
  };
}

/** Playwright's transport invokes its async CDP callback without awaiting it.
 * A late unmatched reply can therefore reject outside the collector's try/catch.
 * Fence every concurrent collection when the protocol cannot identify its owner;
 * no partial capture is accepted as a completed official query. */
const active = new Set<(reason: Error) => void>();
export function isIntegrityProtocolRejection(reason: unknown): boolean {
  const stack = reason instanceof Error ? (reason.stack ?? '') : '';
  return (
    /playwright-core\/lib\/coreBundle\.js/.test(stack) &&
    /\bat assert /.test(stack) &&
    /\bat _CRSession\._onMessage /.test(stack) &&
    /\bat CRConnection\._onMessage /.test(stack)
  );
}
const onRejection = (reason: unknown) => {
  if (isIntegrityProtocolRejection(reason) && active.size) {
    for (const stop of [...active])
      stop(new Error('INTEGRITY_BROWSER_RUNTIME_FAILED', { cause: reason }));
    return;
  }
  // Retain fail-fast behavior for all unrelated unhandled failures.
  queueMicrotask(() => {
    throw reason;
  });
};
export async function integrityBrowserBoundary<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let failure: Error | undefined;
  const stop = (reason: Error) => {
    failure = reason;
    controller.abort(reason);
  };
  if (!active.size) process.on('unhandledRejection', onRejection);
  active.add(stop);
  try {
    const result = await run(AbortSignal.any([signal, controller.signal]));
    if (failure) throw failure;
    return result;
  } catch (error) {
    throw failure ?? error;
  } finally {
    active.delete(stop);
    if (!active.size) process.removeListener('unhandledRejection', onRejection);
  }
}
