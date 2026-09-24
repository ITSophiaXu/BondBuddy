import { isMarketOffering, type Market, type Offering, type ReportingPeriod } from '@bondbuddy/contracts';

export interface CutoffDecision {
  /** Exact financial reporting cutoff in YYYY-MM-DD form. */
  readonly cutoff: string;
  /** Evidence anchors supporting the classification; empty evidence is invalid. */
  readonly evidence: readonly string[];
  readonly reason: string;
}

export interface UpdateDifficultyEstimateInput {
  readonly profileVersion: number;
  readonly targetRevision: number;
  readonly source: {
    readonly market: Market | null;
    readonly offering: Offering | null;
    readonly reportingPeriods: readonly ReportingPeriod[];
  };
  readonly target: {
    readonly market: Market | null;
    readonly offering: Offering | null;
    readonly reportingPeriods: readonly ReportingPeriod[];
  };
  /** Same-cutoff material replacement decisions. */
  readonly replacements: readonly CutoffDecision[];
  /** Substantial restatement decisions based on the source-period baseline. */
  readonly restatements: readonly CutoffDecision[];
}

export interface UpdateDifficultyEstimate {
  readonly profileVersion: number;
  readonly targetRevision: number;
  readonly status: 'ready' | 'needs_confirmation';
  readonly estimatedN: number | null;
  readonly sourceReportingPeriods: readonly ReportingPeriod[];
  readonly targetReportingPeriods: readonly ReportingPeriod[];
  readonly latestConfirmedSourceCutoff: string | null;
  readonly retainedCutoffs: readonly string[];
  readonly newCutoffs: readonly string[];
  readonly replacementCutoffs: readonly string[];
  readonly restatementCutoffs: readonly string[];
  readonly structureAdaptationRequired: boolean | null;
  readonly confirmationReasons: readonly string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function inspectPeriods(label: string, periods: readonly ReportingPeriod[], reasons: string[]): Set<string> {
  const cutoffs = new Set<string>();
  if (periods.length === 0) reasons.push(`${label}_periods_missing`);

  for (const period of periods) {
    const cutoff = period.end;
    if (!cutoff || !validDate(cutoff)) {
      reasons.push(`${label}_period_end_missing_or_invalid`);
      continue;
    }
    if (!period.start || !validDate(period.start)
      || period.period_kind === null
      || period.scope === null
      || period.status === 'unknown'
      || period.status === 'needs_confirmation'
      || period.uncertainty.length > 0) {
      reasons.push(`${label}_period_needs_confirmation:${cutoff}`);
      continue;
    }
    if (period.start > cutoff) {
      reasons.push(`${label}_period_start_after_end:${cutoff}`);
      continue;
    }
    cutoffs.add(cutoff);
  }
  return cutoffs;
}

function inspectMarketOffering(
  side: 'source' | 'target',
  market: Market | null,
  offering: Offering | null,
  reasons: string[],
): void {
  if (market === null) reasons.push(`${side}_market_missing`);
  if (offering === null) reasons.push(`${side}_offering_missing`);
  if (market !== null && offering !== null && !isMarketOffering(market, offering)) {
    reasons.push(`${side}_market_offering_incompatible`);
  }
}

function inspectDecisions(
  kind: 'replacement' | 'restatement',
  decisions: readonly CutoffDecision[],
  sourceCutoffs: ReadonlySet<string>,
  targetCutoffs: ReadonlySet<string>,
  reasons: string[],
): Set<string> {
  const accepted = new Set<string>();
  for (const decision of decisions) {
    const cutoff = decision.cutoff;
    const evidence = decision.evidence.map((item) => item.trim()).filter(Boolean);
    if (!validDate(cutoff) || !sourceCutoffs.has(cutoff) || !targetCutoffs.has(cutoff)
      || evidence.length === 0 || decision.reason.trim() === '') {
      reasons.push(`${kind}_decision_invalid:${cutoff || 'missing_cutoff'}`);
      continue;
    }
    accepted.add(cutoff);
  }
  return accepted;
}

/**
 * Estimates changed reporting cutoffs for preflight only. It never calculates
 * actual_N, pricing, or model/work usage. A cutoff counts once regardless of
 * statement count, reporting scope, or duplicate material count.
 */
export function estimateUpdateDifficulty(input: UpdateDifficultyEstimateInput): UpdateDifficultyEstimate {
  const reasons: string[] = [];
  if (!Number.isSafeInteger(input.profileVersion) || input.profileVersion < 1) reasons.push('profile_version_invalid');
  if (!Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1) reasons.push('target_revision_invalid');
  inspectMarketOffering('source', input.source.market, input.source.offering, reasons);
  inspectMarketOffering('target', input.target.market, input.target.offering, reasons);
  const sourceCutoffs = inspectPeriods('source', input.source.reportingPeriods, reasons);
  const targetCutoffs = inspectPeriods('target', input.target.reportingPeriods, reasons);

  const replacements = inspectDecisions('replacement', input.replacements, sourceCutoffs, targetCutoffs, reasons);
  const restatements = inspectDecisions('restatement', input.restatements, sourceCutoffs, targetCutoffs, reasons);
  const changedCutoffs = new Set([...replacements, ...restatements]);
  const newCutoffs = new Set([...targetCutoffs].filter((cutoff) => !sourceCutoffs.has(cutoff)));
  const retainedCutoffs = new Set([...targetCutoffs].filter((cutoff) => sourceCutoffs.has(cutoff) && !changedCutoffs.has(cutoff)));
  const latestConfirmedSourceCutoff = sourceCutoffs.size > 0 ? sorted(sourceCutoffs).at(-1) ?? null : null;

  const ready = reasons.length === 0;
  const sourcePairValid = input.source.market !== null && input.source.offering !== null
    && isMarketOffering(input.source.market, input.source.offering);
  const targetPairValid = input.target.market !== null && input.target.offering !== null
    && isMarketOffering(input.target.market, input.target.offering);
  const structureAdaptationRequired = sourcePairValid && targetPairValid
    ? input.source.market !== input.target.market || input.source.offering !== input.target.offering
    : null;

  return {
    profileVersion: input.profileVersion,
    targetRevision: input.targetRevision,
    status: ready ? 'ready' : 'needs_confirmation',
    estimatedN: ready ? new Set([...newCutoffs, ...changedCutoffs]).size : null,
    sourceReportingPeriods: input.source.reportingPeriods,
    targetReportingPeriods: input.target.reportingPeriods,
    latestConfirmedSourceCutoff,
    retainedCutoffs: sorted(retainedCutoffs),
    newCutoffs: sorted(newCutoffs),
    replacementCutoffs: sorted(replacements),
    restatementCutoffs: sorted(restatements),
    structureAdaptationRequired,
    confirmationReasons: [...new Set(reasons)].sort(),
  };
}
