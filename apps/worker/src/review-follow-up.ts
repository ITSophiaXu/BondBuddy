import type { ReviewFinding, ReviewReport, ReviewFollowUp } from '@bondbuddy/contracts';
import { evidenceKey, reviewContentHash } from '../../../packages/domain/dist/review-evidence.js';
import type { ReviewAnalysisInput } from './review-analysis-protocol.js';

/** Pure projection of real report rows. Missing or carried rows never establish resolution. */
export function withReviewFollowUp(
  report: ReviewReport,
  input: Pick<ReviewAnalysisInput, 'scope' | 'previous_report'>,
): ReviewReport {
  if (input.scope.mode !== 'differential_review' || !input.previous_report) return report;
  const previous = input.previous_report,
    selected = new Set(input.scope.finding_ids);
  const rows: ReviewFollowUp['findings'] = previous.findings.map((prior) => {
    if (!selected.has(prior.finding_id))
      return {
        source_finding_id: prior.finding_id,
        current_finding_ids: report.findings
          .filter((f) => f.finding_id === prior.finding_id && f.check_status === 'carried_forward')
          .map((f) => f.finding_id),
        coverage_check_ids: report.coverage
          .filter(
            (c) => c.check_status === 'carried_forward' && c.finding_ids.includes(prior.finding_id),
          )
          .map((c) => c.check_id),
        status: 'carried_forward',
        outcome: 'carried_forward',
        reason: '不在本轮确认范围；沿用来源报告的结论和核验时点。',
      };
    const scope = report.coverage.find(
      (c) => c.check_id === `scope:${prior.finding_id}` && c.check_status === 'rechecked',
    );
    const category =
      prior.public_category ??
      previous.coverage
        .find(
          (c) =>
            c.dimension === 'public' &&
            c.finding_ids.includes(prior.finding_id) &&
            c.check_id.startsWith('public:'),
        )
        ?.check_id.slice(7);
    const checks = report.coverage.filter(
      (c) =>
        c.check_status === 'rechecked' &&
        (c === scope ||
          (prior.dimension === 'public' && category && c.check_id === `public:${category}`)),
    );
    const linked = new Set(checks.flatMap((c) => c.finding_ids));
    const overlaps = (f: ReviewFinding) =>
      f.dimension === prior.dimension &&
      f.target_refs.some((r) => prior.target_refs.some((p) => evidenceKey(r) === evidenceKey(p)));
    const current = report.findings.filter(
      (f) => f.check_status === 'rechecked' && (linked.has(f.finding_id) || overlaps(f)),
    );
    const mapped = report.findings.filter((f) => linked.has(f.finding_id) || current.includes(f));
    const pending = current.some((f) =>
      f.limitations.includes('selected_finding_not_independently_resolved'),
    );
    const publicChecked =
      prior.dimension === 'public' &&
      checks.some((c) => (c.public_sources?.length ?? 0) > 0 && c.outcome !== 'uncovered');
    const incomplete =
      !scope ||
      scope.outcome === 'uncovered' ||
      pending ||
      (prior.dimension === 'public' && !publicChecked);
    const resolved =
      !incomplete &&
      scope?.outcome === 'pass' &&
      !mapped.length &&
      (scope.evidence_refs.length > 0 ||
        scope.rule_refs.length > 0 ||
        (scope.public_sources?.length ?? 0) > 0);
    const outcome: ReviewFollowUp['findings'][number]['outcome'] = resolved
      ? 'resolved'
      : incomplete
        ? 'uncovered'
        : current.some((f) => f.conclusion === 'error' || f.conclusion === 'conflict')
          ? 'issue'
          : current.some((f) => f.conclusion === 'needs_evidence')
            ? 'needs_evidence'
            : 'manual';
    return {
      source_finding_id: prior.finding_id,
      current_finding_ids: mapped.map((f) => f.finding_id),
      coverage_check_ids: checks.map((c) => c.check_id),
      status: incomplete ? 'uncompleted' : 'rechecked',
      outcome,
      reason: incomplete
        ? (scope?.reason ?? '本轮未取得此对象的明确检查结果；缺少映射或实际覆盖，不能认定解决。')
        : checks.map((c) => c.reason).join('；') || '本轮检查结果仍须人工核对。',
    };
  });
  return {
    ...report,
    follow_up: {
      version: 'review-follow-up-v1',
      source_report_id: previous.report_id,
      source_report_sha256: reviewContentHash(previous),
      findings: rows,
    },
  };
}
