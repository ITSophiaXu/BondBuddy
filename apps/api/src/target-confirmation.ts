import type { Pool, PoolClient } from 'pg';
import type { Market, Offering, TargetReportingPeriod } from '@bondbuddy/contracts';

export type TargetConfirmationRequest = {
  market: Market;
  offering: Offering;
  document_purpose: 'registration' | 'issuance' | null;
  as_of: string | null;
  target_reporting_periods: TargetReportingPeriod[];
};
export type TargetConfirmation = TargetConfirmationRequest & {
  status: 'confirmed'; confirmed_by: string; confirmed_at: string;
};

const periodKey = (period: TargetReportingPeriod) => JSON.stringify([
  period.start, period.end, period.period_kind, period.scope,
]);

export function canonicalTargetPeriods(periods: TargetReportingPeriod[]): TargetReportingPeriod[] {
  const sorted = periods.map(period => ({ start: period.start, end: period.end, period_kind: period.period_kind,
    scope: period.scope, status: period.status, evidence_refs: period.evidence_refs })).sort((a, b) => periodKey(a).localeCompare(periodKey(b)));
  const unique: TargetReportingPeriod[] = [];
  for (const period of sorted) {
    const previous = unique.at(-1);
    if (previous && periodKey(previous) === periodKey(period)) {
      if (JSON.stringify(previous) !== JSON.stringify(period)) throw new Error('TARGET_PERIOD_CONFLICT');
      continue;
    }
    unique.push(period);
  }
  return unique;
}

function validDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export function confirmTargetIntent(request: TargetConfirmationRequest, draft: {
  market: Market | null; offering: Offering | null; target_reporting_periods?: TargetReportingPeriod[];
}, user: string, confirmedAt: string): TargetConfirmation {
  if (request.market !== draft.market || request.offering !== draft.offering) throw new Error('TARGET_DRAFT_MISMATCH');
  if (request.as_of !== null && !validDay(request.as_of)) throw new Error('TARGET_DATE_INVALID');
  const periods = canonicalTargetPeriods(request.target_reporting_periods);
  if (JSON.stringify(periods) !== JSON.stringify(canonicalTargetPeriods(draft.target_reporting_periods ?? [])))
    throw new Error('TARGET_DRAFT_MISMATCH');
  return { status: 'confirmed', market: request.market, offering: request.offering,
    document_purpose: request.document_purpose, as_of: request.as_of,
    target_reporting_periods: periods, confirmed_by: user, confirmed_at: confirmedAt };
}

/** Trusted, owner-scoped revision lookup for background/rule consumers. Null means unconfirmed. */
export async function loadTargetConfirmation(db: Pool | PoolClient, ownerUserId: string, projectId: string, revision: number): Promise<TargetConfirmation | null> {
  const result = await db.query(`SELECT market,offering,document_purpose,as_of,target_reporting_periods,confirmed_by,confirmed_at
    FROM bb_input_revision_target_confirmations WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3`,
  [ownerUserId, projectId, revision]);
  const row = result.rows[0];
  if (!row) return null;
  return { status: 'confirmed', market: row.market, offering: row.offering,
    document_purpose: row.document_purpose, as_of: row.as_of === null ? null : row.as_of.toISOString().slice(0, 10),
    target_reporting_periods: row.target_reporting_periods, confirmed_by: row.confirmed_by,
    confirmed_at: row.confirmed_at.toISOString() };
}
