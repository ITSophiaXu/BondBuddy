export type LeaseHeartbeatEvent = {
  outcome: 'renew_retry' | 'renewed_after_retry' | 'aborted';
  reason?: 'lease_lost' | 'renew_error' | 'lease_safety_deadline';
  error_code?: string;
  last_successful_renew_at: string | null;
  safe_lease_until: string;
};

const transientCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01', '57P01', '57P02', '57P03', '53300',
]);

function errorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? (error as {code?: unknown}).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{2,30}$/.test(code) ? code : undefined;
}

function connectionFailure(error: unknown): string | undefined {
  const code = errorCode(error);
  if (code && transientCodes.has(code)) return code;
  const message = error instanceof Error ? error.message : '';
  if (/^(?:Connection terminated unexpectedly|Connection terminated|Connection ended unexpectedly|TIMEOUTconnect exceeded|timeout exceeded when trying to connect)$/.test(message))
    return 'DB_CONNECTION_INTERRUPTED';
  return undefined;
}

/** A conservative local deadline is based on the time before the database accepted each renewal. */
export function startLeaseHeartbeat(options: {
  leaseMs: number;
  claimedAtMs: number;
  renew: () => Promise<void>;
  abort: () => void;
  onEvent?: (event: LeaseHeartbeatEvent) => void;
}) {
  const { leaseMs, renew, abort, onEvent } = options;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Invalid lease duration');
  const marginMs = Math.min(5000, Math.max(100, leaseMs * 0.1));
  let deadlineMs = options.claimedAtMs + leaseMs - marginMs;
  let lastSuccessfulRenewAt: string | null = null;
  let stopped = false;
  let failures = 0;
  let nextTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const emit = (event: Omit<LeaseHeartbeatEvent, 'last_successful_renew_at' | 'safe_lease_until'>) => {
    try { onEvent?.({ ...event, last_successful_renew_at: lastSuccessfulRenewAt, safe_lease_until: new Date(deadlineMs).toISOString() }); }
    catch { /* Diagnostics cannot change ownership decisions. */ }
  };
  const stop = () => {
    stopped = true;
    if (nextTimer) clearTimeout(nextTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  };
  const fail = (reason: NonNullable<LeaseHeartbeatEvent['reason']>, code?: string) => {
    if (stopped) return;
    emit({ outcome: 'aborted', reason, ...(code ? { error_code: code } : {}) });
    stop();
    abort();
  };
  const armDeadline = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => fail('lease_safety_deadline'), Math.max(0, deadlineMs - Date.now()));
  };
  const attempt = async () => {
    if (stopped) return;
    if (Date.now() >= deadlineMs) { fail('lease_safety_deadline'); return; }
    const startedAtMs = Date.now();
    try {
      await renew();
      if (stopped) return;
      if (Date.now() >= deadlineMs) { fail('lease_safety_deadline'); return; }
      deadlineMs = startedAtMs + leaseMs - marginMs;
      lastSuccessfulRenewAt = new Date().toISOString();
      if (failures) emit({ outcome: 'renewed_after_retry' });
      failures = 0;
      armDeadline();
      nextTimer = setTimeout(() => { void attempt(); }, Math.max(10, leaseMs * 0.4));
    } catch (error) {
      if (stopped) return;
      const code = errorCode(error);
      if (code === 'ALREADY_TERMINAL' || code === 'NOT_FOUND') { fail('lease_lost', code); return; }
      const transientCode = connectionFailure(error);
      if (!transientCode) { fail('renew_error', code); return; }
      failures++;
      const delayMs = Math.min(2000, 250 * 2 ** Math.min(failures - 1, 3));
      if (Date.now() + delayMs >= deadlineMs) { fail('lease_safety_deadline', transientCode); return; }
      emit({ outcome: 'renew_retry', error_code: transientCode });
      nextTimer = setTimeout(() => { void attempt(); }, delayMs);
    }
  };
  armDeadline();
  nextTimer = setTimeout(() => { void attempt(); }, Math.max(10, leaseMs * 0.4));
  return { stop };
}
