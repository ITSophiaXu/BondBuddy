import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';
import type { LibrarySelectionSnapshot } from './reference-library-selection.js';
import type { CodexAdapterConfig } from './codex-adapter.js';
import {
  noHistoryModelGenerationStage,
  type ApprovedGenerationIssuerBinding,
  type NoHistoryStageAdapters,
  type TrustedRuleSelection,
} from './no-history-model-stage.js';
import type { StageContext } from './run-pipeline.js';

const scope = { ownerUserId: 'owner-synthetic', projectId: 'project-synthetic', runId: 'run-synthetic', inputRevision: 4, inputHash: 'a'.repeat(64) };
const target = { market: 'sse', offering: 'public', instrument: 'corporate-bond', documentStage: 'registration', ruleVersion: 'rules-synthetic-v1' } as const;
const profile: AnnualBusinessProfile = {
  issuerId: 'issuer-synthetic', profileVersion: 'issuer-profile-v1', taxonomyVersion: 'business-taxonomy-v1', fiscalYear: 2025,
  completeAnnualPeriod: true, latestCompleteAnnual: true, verificationStatus: 'verified', accountingScope: 'consolidated',
  revenueBasis: 'main_business_revenue', currency: 'CNY', unit: 'yuan', allComparableBusinessLinesPresent: true, sourceEvidence: ['target-audit-p1'],
  lines: [1, 2, 3].map(rank => ({ code: `business-${rank}`, label: `业务${rank}`, originalLabel: `主业${rank}`, revenue: `${400 - rank * 50}`,
    rank, evidence: [`target-audit-p${rank}`], classificationEvidence: [`target-classification-${rank}`] })),
};
const reviewedProfile = { ...scope, review: { status: 'reviewed' as const, reviewId: 'review-synthetic', reviewerId: 'reviewer-synthetic', reviewedAt: '2026-09-25T00:00:00Z' }, profile };
const rule: TrustedRuleSelection = { ...scope, status: 'eligible_for_evaluation', target, ruleVersion: target.ruleVersion, contentHash: 'b'.repeat(64),
  releaseId: 'production-rule-release', releaseChannel: 'production', rules: [{ ruleId: 'rule-a', title: '披露要求', requirement: '按经核实的目标发行人资料披露。' }] };
const approved: ApprovedGenerationIssuerBinding = { ...scope, bindingId: 'synthetic-binding', version: 1, contentSha256: 'e'.repeat(64),
  issuerEntityId: 'entity:11111111-1111-4111-8111-111111111111', reviewEventId: 'synthetic-review-event', reviewedAt: '2026-09-25T00:00:00Z' };

function adapters(overrides: Partial<NoHistoryStageAdapters> = {}): NoHistoryStageAdapters {
  return {
    loadReviewedIssuerProfile: async () => reviewedProfile,
    loadTargetFacts: async () => ({ ...scope, facts: [{ factId: 'target-fact-1', statement: '目标发行人主营业务收入已核实。', evidenceRefs: ['target-audit-p1'], status: 'verified' as const }] }),
    loadTrustedRuleSelection: async () => rule,
    loadApprovedIssuerBinding: async () => approved,
    selectReference: async () => ({ schema_version: 'reference-selection-v1', query_schema_version: 'reference-library-query-v1.1', status: 'needs_review',
      selection_hash: 'c'.repeat(64), target: {} as never, index_release: null, candidate_decisions: [], selected: null, reasons: ['synthetic_review_gate'] } as unknown as LibrarySelectionSnapshot),
    loadReferenceOutline: async () => null,
    loadUserReferenceOutline: async () => ({ status: 'none' }),
    codexConfig: () => ({} as CodexAdapterConfig),
    templateVersion: 'no-history-template-v1',
    ...overrides,
  };
}

function context(): StageContext {
  return { pool: {} as StageContext['pool'], blobs: {} as StageContext['blobs'], lease: {} as StageContext['lease'],
    run: { id: scope.runId, owner_user_id: scope.ownerUserId, project_id: scope.projectId, input_revision: scope.inputRevision, input_hash: scope.inputHash, task_kind: 'generation' },
    signal: new AbortController().signal, checkpoint: {}, values: new Map() };
}

test('a missing or absent generation issuer binding pauses at the identity gate', async () => {
  for (const loadApprovedIssuerBinding of [async () => null, undefined]) {
    const stage = noHistoryModelGenerationStage(adapters({ loadApprovedIssuerBinding }));
    assert.deepEqual(await stage.run(context()), { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:issuer_identity_not_bound' });
  }
});

test('a binding for another owner/run/input never authorizes this generation run', async () => {
  const mismatches: Array<Partial<ApprovedGenerationIssuerBinding>> = [
    { ownerUserId: 'other-owner' }, { projectId: 'other-project' }, { runId: 'other-run' },
    { inputHash: 'f'.repeat(64) }, { inputRevision: scope.inputRevision + 1 }, { contentSha256: 'not-a-hash' },
  ];
  for (const mismatch of mismatches) {
    const stage = noHistoryModelGenerationStage(adapters({ loadApprovedIssuerBinding: async () => ({ ...approved, ...mismatch }) }));
    assert.deepEqual(await stage.run(context()), { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:issuer_identity_not_bound' }, JSON.stringify(mismatch));
  }
});

test('an approved binding for this exact input passes the identity gate to reference selection', async () => {
  const stage = noHistoryModelGenerationStage(adapters());
  assert.deepEqual(await stage.run(context()), { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:reference_selection_needs_review' });
});

test('a withdrawn or re-parsed binding pauses before the persisted prompt can reach a model', async () => {
  let reads = 0;
  const stage = noHistoryModelGenerationStage(adapters({
    loadApprovedIssuerBinding: async () => { reads++; return reads === 1 ? approved : null; },
    loadUserReferenceOutline: async () => ({ status: 'accepted', outline: { schema_version: 'user-reference-outline-v1', owner_user_id: scope.ownerUserId,
      project_id: scope.projectId, run_id: scope.runId, input_revision: scope.inputRevision, input_hash: scope.inputHash,
      material_id: 'synthetic-reference', material_version: 1, material_sha256: 'd'.repeat(64),
      parse_snapshot_id: 'synthetic-snapshot', review_id: 'synthetic-review', fact_isolation_check_version: 'synthetic-v1',
      chapters: [{ order: 1, heading: '发行概况' }] } }),
  }));
  const ctx = context();
  ctx.validateBeforeModelCall = async () => null;
  assert.deepEqual(await stage.run(ctx), { kind: 'pause', stage: 'capability_not_ready', reason: 'issuer_identity_not_bound' });
  assert.ok(reads >= 2, 'the binding is re-read before the model call');
});
