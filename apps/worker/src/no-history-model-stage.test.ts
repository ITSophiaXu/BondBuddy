import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';
import type { LibrarySelectionSnapshot } from './reference-library-selection.js';
import type { CodexAdapterConfig } from './codex-adapter.js';
import { buildNoHistoryGenerationPrompt, noHistoryModelGenerationStage, validateNoHistoryDraft, type NoHistoryStageAdapters, type TrustedRuleSelection } from './no-history-model-stage.js';
import type { StageContext } from './run-pipeline.js';

const scope = { ownerUserId: 'owner-synthetic', projectId: 'project-synthetic', runId: 'run-synthetic', inputRevision: 4, inputHash: 'a'.repeat(64) };
const target = { market: 'sse', offering: 'public', instrument: 'corporate-bond', documentStage: 'registration', ruleVersion: 'rules-synthetic-v1' } as const;
const profile: AnnualBusinessProfile = {
  issuerId: 'issuer-synthetic', profileVersion: 'issuer-profile-v1', taxonomyVersion: 'business-taxonomy-v1', fiscalYear: 2025,
  completeAnnualPeriod: true, latestCompleteAnnual: true, verificationStatus: 'verified', accountingScope: 'consolidated',
  revenueBasis: 'operating revenue', currency: 'CNY', unit: 'yuan', allComparableBusinessLinesPresent: true, sourceEvidence: ['target-audit-p1'],
  lines: [1, 2, 3].map(rank => ({ code: `business-${rank}`, label: `业务${rank}`, originalLabel: `主业${rank}`, revenue: `${400 - rank * 50}`,
    rank, evidence: [`target-audit-p${rank}`], classificationEvidence: [`target-classification-${rank}`] })),
};
const reviewedProfile = { ...scope, review: { status: 'reviewed' as const, reviewId: 'review-synthetic', reviewerId: 'reviewer-synthetic', reviewedAt: '2026-09-25T00:00:00Z' }, profile };
const rule: TrustedRuleSelection = { ...scope, status: 'eligible_for_evaluation', target, ruleVersion: target.ruleVersion, contentHash: 'b'.repeat(64),
  releaseId: 'production-rule-release', releaseChannel: 'production', rules: [{ ruleId: 'rule-a', title: '披露要求', requirement: '按经核实的目标发行人资料披露。' }] };

function adapters(overrides: Partial<NoHistoryStageAdapters> = {}, counters = { config: 0, rules: 0, select: 0, facts: 0 }): NoHistoryStageAdapters {
  return {
    loadReviewedIssuerProfile: async () => reviewedProfile,
    loadTargetFacts: async () => { counters.facts++; return { ...scope, facts: [{ factId: 'target-fact-1', statement: '目标发行人主营业务收入已核实。', evidenceRefs: ['target-audit-p1'], status: 'verified' as const }] }; },
    loadTrustedRuleSelection: async () => { counters.rules++; return rule; },
    selectReference: async () => { counters.select++; return { schema_version: 'reference-selection-v1', query_schema_version: 'reference-library-query-v1.1', status: 'needs_review', selection_hash: 'c'.repeat(64), target: {} as never,
      index_release: null, candidate_decisions: [], selected: null, reasons: ['synthetic_review_gate'] } as unknown as LibrarySelectionSnapshot; },
    loadReferenceOutline: async () => null,
    codexConfig: () => { counters.config++; return {} as CodexAdapterConfig; },
    templateVersion: 'no-history-template-v1',
    ...overrides,
  };
}

function context(): StageContext {
  return { pool: {} as StageContext['pool'], blobs: {} as StageContext['blobs'], lease: {} as StageContext['lease'],
    run: { id: scope.runId, owner_user_id: scope.ownerUserId, project_id: scope.projectId, input_revision: scope.inputRevision, input_hash: scope.inputHash, task_kind: 'generation' },
    signal: new AbortController().signal, checkpoint: {}, values: new Map() };
}

test('no reviewed target issuer profile pauses before reference selection or model setup', async () => {
  const counts = { config: 0, rules: 0, select: 0, facts: 0 };
  const stage = noHistoryModelGenerationStage(adapters({ loadReviewedIssuerProfile: async () => null }, counts));
  const outcome = await stage.run(context());
  assert.deepEqual(outcome, { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:issuer_annual_business_profile_missing_or_unreviewed' });
  assert.deepEqual(counts, { config: 0, rules: 0, select: 0, facts: 0 });
});

test('ineligible or unavailable trusted target rules pause before reference lookup and model setup', async () => {
  const counts = { config: 0, rules: 0, select: 0, facts: 0 };
  const stage = noHistoryModelGenerationStage(adapters({ loadTrustedRuleSelection: async () => { counts.rules++; return null; } }, counts));
  const outcome = await stage.run(context());
  assert.deepEqual(outcome, { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:target_rule_capability_not_ready' });
  assert.deepEqual(counts, { config: 0, rules: 1, select: 0, facts: 0 });
});

test('non-exact or unlocked v1.1 reference selection pauses after target facts but before model setup', async () => {
  const counts = { config: 0, rules: 0, select: 0, facts: 0 };
  const stage = noHistoryModelGenerationStage(adapters({}, counts));
  const outcome = await stage.run(context());
  assert.deepEqual(outcome, { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:reference_selection_needs_review' });
  assert.deepEqual(counts, { config: 0, rules: 1, select: 1, facts: 1 });
});

test('a v1-labelled or mismatched lock cannot authorize a v1.1 no-history model call', async () => {
  const counts = { config: 0, rules: 0, select: 0, facts: 0 };
  const base = {
    schema_version: 'reference-selection-v1', query_schema_version: 'reference-library-query-v1.1', status: 'exact',
    selection_hash: 'c'.repeat(64), target: {} as never, index_release: { release_id: 'release-synthetic' },
    candidate_decisions: [], reasons: [],
    selected: { reference_id: 'reference-synthetic', document_version_id: 'document-synthetic', profile_id: 'profile-synthetic',
      lock: { lock_id: 'lock-synthetic', query_schema_version: 'reference-library-query-v1',
        document_version_id: 'document-synthetic', profile_id: 'profile-synthetic', index_release_id: 'release-synthetic' } },
  } as unknown as LibrarySelectionSnapshot;
  for (const lock of [base.selected!.lock,
    { ...base.selected!.lock, query_schema_version: 'reference-library-query-v1.1' as const, profile_id: 'other-profile' }]) {
    const stage = noHistoryModelGenerationStage(adapters({ selectReference: async () =>
      ({ ...base, selected: { ...base.selected!, lock } }) as LibrarySelectionSnapshot }, counts));
    assert.deepEqual(await stage.run(context()), { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:reference_selection_exact' });
  }
  assert.equal(counts.config, 0);
});

test('stage cannot process an update run through the no-history generation path', async () => {
  const counts = { config: 0, rules: 0, select: 0, facts: 0 };
  const stage = noHistoryModelGenerationStage(adapters({}, counts));
  const ctx = context();
  ctx.run.task_kind = 'update';
  assert.deepEqual(await stage.run(ctx), { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:task_kind_not_no_history_generation' });
  assert.deepEqual(counts, { config: 0, rules: 0, select: 0, facts: 0 });
});

test('missing target facts pauses before a reference can be locked', async () => {
  const counts = { config: 0, rules: 0, select: 0, facts: 0 };
  const stage = noHistoryModelGenerationStage(adapters({ loadTargetFacts: async () => { counts.facts++; return null; } }, counts));
  const outcome = await stage.run(context());
  assert.deepEqual(outcome, { kind: 'pause', stage: 'capability_not_ready', reason: 'needs_review:target_issuer_facts_missing_or_unreviewed' });
  assert.deepEqual(counts, { config: 0, rules: 1, select: 0, facts: 1 });
});

test('generation prompt contains target issuer evidence and drops any non-allowlisted reference payload', () => {
  const prompt = buildNoHistoryGenerationPrompt({ scope, profile, facts: [{ factId: 'target-fact-1', statement: 'Target has verified revenue.', evidenceRefs: ['target-audit-p1'], status: 'verified' }],
    rule, chapters: [{ order: 2, heading: 'Business Overview', issuerFacts: 'REFERENCE ISSUER SECRET: Never disclose this' }, { order: 1, heading: 'Summary' }] as never });
  assert.match(prompt, /Target has verified revenue/);
  assert.match(prompt, /target-fact-1/);
  assert.match(prompt, /Summary/);
  assert.doesNotMatch(prompt, /REFERENCE ISSUER SECRET/);
  assert.doesNotMatch(prompt, /reference issuer profile/i);
});

test('versioned draft validation rejects fact IDs outside the owner-scoped target snapshot', () => {
  const draft = { schema_version: 'no-history-manuscript-draft-v1', sections: [{ heading: '经营情况', body: '事实见 source.' }],
    fact_claims: [{ claim: '营业收入为 100。', target_fact_ids: ['library-fact-unknown'] }], open_questions: [] };
  assert.equal(validateNoHistoryDraft(draft, new Set(['target-fact-1'])), false);
  assert.equal(validateNoHistoryDraft({ ...draft, fact_claims: [{ claim: '营业收入为 100。', target_fact_ids: ['target-fact-1'] }] }, new Set(['target-fact-1'])), true);
  assert.equal(validateNoHistoryDraft({ ...draft, sections: [], fact_claims: [] }, new Set(['target-fact-1'])), false);
});
