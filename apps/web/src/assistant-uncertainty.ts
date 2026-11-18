import {assistantSame} from './assistant-view-cache.js';

/**
 * A changed server identity (messages, cards, active run or project revision)
 * is server-side evidence that the uncertain write was accepted. An unchanged
 * identity remains uncertain; callers must not retry automatically.
 */
export function uncertainServerAccepted(saved: unknown, server: unknown): boolean {
  if (saved === undefined || saved === null) return false;
  return !assistantSame(saved, server);
}
