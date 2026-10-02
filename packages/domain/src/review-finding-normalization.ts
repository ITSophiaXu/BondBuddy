import type { ReviewFinding, ReviewCheckCoverage, ReviewEvidenceRef, ReviewRuleRef } from '../../contracts/dist/review-results.js';
import { canonical, reviewContentHash, uniqueEvidence, validateReviewEvidence, validateReviewRule,
  type ReviewEvidenceContext } from './review-evidence.js';

/** An internal evaluator result; raw model findings default to model_only. */
export interface ReviewFindingCandidate {
  stable_key: string;
  dimension: ReviewFinding['dimension']; conclusion: ReviewFinding['conclusion']; severity: ReviewFinding['severity'];
  title: string; description: string; target_refs: ReviewEvidenceRef[]; evidence_refs: ReviewEvidenceRef[];
  rule_refs?: ReviewRuleRef[]; suggested_change?: string; limitations?: string[];
  calculation?: ReviewFinding['calculation'];
  verification?: 'deterministic' | 'evidence_based' | 'model_only';
  can_revise?: boolean;
}

export function normalizeReviewFindings(candidates: readonly ReviewFindingCandidate[], ctx: ReviewEvidenceContext): ReviewFinding[] {
  const merged = new Map<string, ReviewFinding>();
  for (const candidate of candidates) {
    if (!candidate.stable_key.trim() || !candidate.title.trim() || !candidate.description.trim()) throw new Error('REVIEW_FINDING_CONTENT_REQUIRED');
    const problems = [...(candidate.limitations ?? [])];
    const targets = candidate.target_refs.filter(ref => {
      const errors = validateReviewEvidence(ref, ctx, true); problems.push(...errors); return errors.length === 0;
    });
    const evidence = candidate.evidence_refs.filter(ref => {
      const errors = validateReviewEvidence(ref, ctx); problems.push(...errors); return errors.length === 0;
    });
    const rules = (candidate.rule_refs ?? []).filter(ref => {
      const errors = validateReviewRule(ref, ctx); problems.push(...errors); return errors.length === 0;
    });
    const uncertain = [...targets, ...evidence].some(ref => ref.uncertainty.length > 0);
    if (uncertain) problems.push('source_parse_uncertainty');
    if (!evidence.length) problems.push('supporting_evidence_missing');
    if (!targets.length) problems.push('target_anchor_missing');
    if (candidate.dimension === 'compliance' && (!rules.length || rules.some(rule => rule.applicability !== 'applicable'))) problems.push('applicable_rule_missing');
    if (candidate.conclusion === 'error' && (!candidate.verification || candidate.verification === 'model_only')) problems.push('model_claim_requires_independent_validation');
    const degraded = problems.length > (candidate.limitations?.length ?? 0);
    const conclusion = candidate.conclusion === 'error' && degraded ? 'manual' : candidate.conclusion;
    const canRevise = candidate.can_revise === true && conclusion === 'error' && !degraded && !!candidate.suggested_change?.trim();
    const identity = canonical([ctx.source_material, candidate.dimension, candidate.stable_key, conclusion,
      candidate.description, candidate.calculation ?? null, rules.map(rule => [rule.rule_id,rule.rule_version,rule.source_sha256]).sort((a,b) => canonical(a).localeCompare(canonical(b)))]);
    const id = `F-${reviewContentHash(identity).slice(0, 24)}`;
    const finding: ReviewFinding = {
      finding_id: id, report_id: ctx.report_id, dimension: candidate.dimension, conclusion, severity: candidate.severity,
      title: candidate.title, description: candidate.description, target_refs: uniqueEvidence(targets), evidence_refs: uniqueEvidence(evidence),
      rule_refs: rules, ...(candidate.suggested_change?.trim() ? { suggested_change: candidate.suggested_change } : {}),
      ...(candidate.calculation ? { calculation: candidate.calculation } : {}), limitations: [...new Set(problems)].sort(),
      repairability: { can_revise: canRevise, reason: canRevise ? '有有效原文、依据及经核对的修订建议。' : '须先解决证据、适用性或判断限制，再明确选择修订。',
        allowed_record_ids: canRevise ? [...new Set(targets.map(ref => ref.record_id))].sort() : [] },
      origin_report_id: ctx.report_id, check_status: 'rechecked',
    };
    const previous = merged.get(id);
    if (previous) {
      if (previous.suggested_change !== finding.suggested_change) {
        previous.limitations.push('conflicting_suggested_changes');
        delete previous.suggested_change;
        previous.repairability.can_revise = false;
        previous.repairability.reason = '同一问题的修订建议存在冲突，须先核对。';
      }
      previous.target_refs = uniqueEvidence([...previous.target_refs, ...finding.target_refs]);
      previous.evidence_refs = uniqueEvidence([...previous.evidence_refs, ...finding.evidence_refs]);
      previous.limitations = [...new Set([...previous.limitations, ...finding.limitations])].sort();
      previous.repairability.can_revise &&= finding.repairability.can_revise;
      previous.repairability.allowed_record_ids = previous.repairability.can_revise
        ? [...new Set([...previous.repairability.allowed_record_ids, ...finding.repairability.allowed_record_ids])].sort() : [];
    } else merged.set(id, finding);
  }
  return [...merged.values()].sort((a, b) => a.finding_id.localeCompare(b.finding_id));
}

/** Carrying a prior finding does not claim it was checked against the new input. */
export function carryForwardReviewFindings(previous: readonly ReviewFinding[], selectedIds: readonly string[], reportId: string): ReviewFinding[] {
  if (new Set(previous.map(f => f.finding_id)).size !== previous.length) throw new Error('REVIEW_DUPLICATE_FINDING_ID');
  if (selectedIds.some(id => !previous.some(f => f.finding_id === id))) throw new Error('REVIEW_UNKNOWN_FINDING_ID');
  const selected = new Set(selectedIds);
  return previous.filter(finding => !selected.has(finding.finding_id)).map(finding => ({ ...structuredClone(finding),
    report_id: reportId, check_status: 'carried_forward', origin_report_id: finding.origin_report_id,
    repairability: { can_revise: false, reason: '沿用先前报告，本轮未重新核验；修订前须核对当前文稿位置及依据。', allowed_record_ids: [] } }));
}

export interface ReviewEvaluation { findings: ReviewFinding[]; coverage: ReviewCheckCoverage[]; limitations: string[] }
export function reviewCoverage(ctx: ReviewEvidenceContext, checkId: string, dimension: ReviewFinding['dimension'],
  outcome: ReviewCheckCoverage['outcome'], reason: string, evidence: ReviewEvidenceRef[], findings: ReviewFinding[] = [], rules: ReviewRuleRef[] = []): ReviewCheckCoverage {
  return { check_id: checkId, dimension, outcome, reason, evidence_refs: uniqueEvidence(evidence), rule_refs: rules,
    finding_ids: findings.map(f => f.finding_id), origin_report_id: ctx.report_id, check_status: 'rechecked' };
}
