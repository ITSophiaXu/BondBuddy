/**
 * A supplier call whose result cannot be observed must never be guessed or
 * replayed. It also must not keep a paused run in the lease sweep forever:
 * `codex exec` has no lookup API, so the default reconciler can only answer
 * `unknown`. Bound that state durably and expose it as evidence; the run stays
 * paused for an operator, but the sweep no longer re-queries it every pass.
 */
export const PROVIDER_RECONCILE_UNKNOWN_GRACE_MS = 60 * 60 * 1000;

export interface ProviderReconcileUnknownState {
  first_at: string;
  last_at: string;
  queries: number;
  reconciler: string;
  exhausted: boolean;
}

export interface ProviderReconcileUnknownTransition {
  state: ProviderReconcileUnknownState;
  first: boolean;
  exhausted: boolean;
  previousExhausted: boolean;
}

const validTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Pure transition used by both the durable queue write and its unit tests. */
export function nextProviderReconcileUnknown(
  previous: unknown,
  now: number,
  reconciler: string,
  graceMs = PROVIDER_RECONCILE_UNKNOWN_GRACE_MS
): ProviderReconcileUnknownTransition {
  if (!Number.isFinite(now) || !Number.isSafeInteger(graceMs) || graceMs < 1)
    throw new Error('Invalid provider reconcile unknown transition');
  const prior =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? (previous as Partial<ProviderReconcileUnknownState>)
      : null;
  const first = !validTime(prior?.first_at);
  const firstAt = first ? new Date(now).toISOString() : prior!.first_at!;
  const queries =
    Number.isSafeInteger(prior?.queries) && Number(prior!.queries) >= 0
      ? Number(prior!.queries) + 1
      : 1;
  const previousExhausted = prior?.exhausted === true;
  const exhausted = previousExhausted || now - Date.parse(firstAt) >= graceMs;
  return {
    state: {
      first_at: firstAt,
      last_at: new Date(now).toISOString(),
      queries,
      reconciler,
      exhausted
    },
    first,
    exhausted,
    previousExhausted
  };
}
