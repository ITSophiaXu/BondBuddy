import type { Pool } from 'pg';
import { raiseAlert } from '@bondbuddy/api/evidence-gate';

export type BalanceBand = 'negative' | 'zero' | 'below_threshold' | 'healthy' | 'unknown';
export function balanceBand(raw: unknown, threshold: number): BalanceBand {
  const value = typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return 'unknown';
  return value < 0
    ? 'negative'
    : value === 0
      ? 'zero'
      : value < threshold
        ? 'below_threshold'
        : 'healthy';
}

/** Only the availability flag and a balance band leave this function. Response bodies are never logged. */
export async function probeProviderBalance(
  pool: Pick<Pool, 'query'>,
  options: {
    key: string;
    threshold: number;
    baseUrl?: string;
    fetcher?: typeof fetch;
  },
) {
  const url = new URL(options.baseUrl ?? 'https://api.deepseek.com');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid provider balance base URL');
  let status: 'critical' | 'warning' | 'healthy' = 'warning';
  let band: BalanceBand = 'unknown';
  let available: boolean | null = null;
  try {
    const response = await (options.fetcher ?? fetch)(new URL('/user/balance', url), {
      headers: { Authorization: `Bearer ${options.key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Balance request failed');
    const data = (await response.json()) as { is_available?: unknown; balance_infos?: unknown };
    if (typeof data.is_available !== 'boolean' || !Array.isArray(data.balance_infos))
      throw new Error('Invalid balance response');
    available = data.is_available;
    const usd = data.balance_infos.find(
      (entry: unknown) =>
        entry && typeof entry === 'object' && (entry as { currency?: unknown }).currency === 'USD',
    ) as { total_balance?: unknown } | undefined;
    band = balanceBand(usd?.total_balance, options.threshold);
    status =
      !available || band === 'negative' || band === 'zero' || band === 'below_threshold'
        ? 'critical'
        : band === 'unknown'
          ? 'warning'
          : 'healthy';
  } catch {
    status = 'warning';
  }
  if (status !== 'healthy')
    await raiseAlert(pool as Pool, {
      kind: 'scheduled_task_failed',
      severity: status,
      scope: status === 'critical' ? 'provider_balance_low' : 'provider_balance_probe_failed',
      detail: {
        task: 'provider_balance',
        reason_code:
          status === 'critical' ? 'provider_balance_low' : 'provider_balance_probe_failed',
        is_available: available === null ? 'unknown' : String(available),
        balance_band: band,
      },
    });
  return { status, is_available: available, balance_band: band };
}
