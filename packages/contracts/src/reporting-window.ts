import { MARKET_OFFERINGS } from './public-enums.js';
import type { Market, Offering } from './index.js';
import type { TargetReportingPeriod } from './update-project.js';

/** Standard calendar-year authoring window, not an audited fact or an exemption decision.
 * Exchange private / PPN prospectus: two years; public / MTN / CP / SCP / DFI: three.
 * PPN agreement routes, non-calendar years and other exceptions remain worker knowledge decisions.
 */
export function reportingWindow(market: Market | null, offering: Offering | null, cutoff: string | null): TargetReportingPeriod[] {
  if (!market || !offering || !(MARKET_OFFERINGS[market] as readonly string[]).includes(offering)) return [];
  const match = /^(\d{4})-(03-31|06-30|09-30|12-31)$/.exec(cutoff ?? '');
  if (!match) return [];
  const count = offering === 'private' || offering === 'ppn' ? 2 : 3;
  const year = Number(match[1]), annualEnd = year - (match[2] === '12-31' ? 0 : 1);
  if (annualEnd < count) return [];
  const period = (year: number, end: string, kind: 'annual' | 'interim'): TargetReportingPeriod => ({
    start: `${String(year).padStart(4, '0')}-01-01`, end, period_kind: kind,
    scope: null, status: 'needs_confirmation', evidence_refs: []
  });
  const periods = Array.from({ length: count }, (_, i) => {
    const y = annualEnd - count + i + 1;
    return period(y, `${String(y).padStart(4, '0')}-12-31`, 'annual');
  });
  if (match[2] !== '12-31') periods.push(period(year, cutoff!, 'interim'));
  return periods;
}
