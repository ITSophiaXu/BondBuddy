import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { GenerationIssuerBindingResponse } from '@bondbuddy/contracts';
import type { AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';
import type { LibrarySelectionSnapshot } from './reference-library-selection.js';
import type { CodexAdapterConfig } from './codex-adapter.js';
import type { VerifyPinnedBinding } from './generation-issuer-binding-loader.js';
import {
  noHistoryModelGenerationStage,
  type ApprovedGenerationIssuerBinding,
  type NoHistoryStageAdapters,
  type TrustedRuleSelection,
} from './no-history-model-stage.js';
import type { StageContext } from './run-pipeline.js';

const scope = {
  ownerUserId: 'owner-synthetic',
  projectId: 'project-synthetic',
  runId: 'run-synthetic',
  inputRevision: 4,
  inputHash: 'a'.repeat(64),
};
const target = {
  market: 'sse',
  offering: 'public',
  instrument: 'corporate-bond',
  documentStage: 'registration',
  ruleVersion: 'rules-synthetic-v1',
} as const;
const profile: AnnualBusinessProfile = {
  issuerId: 'issuer-synthetic',
  profileVersion: 'issuer-profile-v1',
  taxonomyVersion: 'business-taxonomy-v1',
  fiscalYear: 2025,
  completeAnnualPeriod: true,
  latestCompleteAnnual: true,
  verificationStatus: 'verified',
  accountingScope: 'consolidated',
  revenueBasis: 'main_business_revenue',
  currency: 'CNY',
  unit: 'yuan',
  allComparableBusinessLinesPresent: true,
  sourceEvidence: ['target-audit-p1'],
  lines: [1, 2, 3].map((rank) => ({
    code: `business-${rank}`,
    label: `业务${rank}`,
    originalLabel: `主业${rank}`,
    revenue: `${400 - rank * 50}`,
    rank,
    evidence: [`target-audit-p${rank}`],
    classificationEvidence: [`target-classification-${rank}`],
  })),
};
const reviewedProfile = {
  ...scope,
  review: {
    status: 'reviewed' as const,
    reviewId: 'review-synthetic',
    reviewerId: 'reviewer-synthetic',
    reviewedAt: '2026-09-25T00:00:00Z',
  },
  profile,
};
const rule: TrustedRuleSelection = {
  ...scope,
  status: 'eligible_for_evaluation',
  target,
  ruleVersion: target.ruleVersion,
  contentHash: 'b'.repeat(64),
  releaseId: 'production-rule-release',
  releaseChannel: 'production',
  rules: [{ ruleId: 'rule-a', title: '披露要求', requirement: '按经核实的目标发行人资料披露。' }],
};
const approved: ApprovedGenerationIssuerBinding = {
  ...scope,
  bindingId: 'synthetic-binding',
  version: 1,
  contentSha256: 'e'.repeat(64),
  issuerEntityId: 'entity:11111111-1111-4111-8111-111111111111',
  reviewEventId: 'synthetic-review-event',
  reviewedAt: '2026-09-25T00:00:00Z',
};

function adapters(overrides: Partial<NoHistoryStageAdapters> = {}): NoHistoryStageAdapters {
  return {
    loadReviewedIssuerProfile: async () => reviewedProfile,
    loadTargetFacts: async () => ({
      ...scope,
      facts: [
        {
          factId: 'target-fact-1',
          statement: '目标发行人主营业务收入已核实。',
          evidenceRefs: ['target-audit-p1'],
          status: 'verified' as const,
        },
      ],
    }),
    loadTrustedRuleSelection: async () => rule,
    loadApprovedIssuerBinding: async () => approved,
    selectReference: async () =>
      ({
        schema_version: 'reference-selection-v1',
        query_schema_version: 'reference-library-query-v1.1',
        status: 'needs_review',
        selection_hash: 'c'.repeat(64),
        target: {} as never,
        index_release: null,
        candidate_decisions: [],
        selected: null,
        reasons: ['synthetic_review_gate'],
      }) as unknown as LibrarySelectionSnapshot,
    loadReferenceOutline: async () => null,
    loadUserReferenceOutline: async () => ({ status: 'none' }),
    codexConfig: () => ({}) as CodexAdapterConfig,
    templateVersion: 'no-history-template-v1',
    ...overrides,
  };
}

function context(): StageContext {
  return {
    pool: {} as StageContext['pool'],
    blobs: {} as StageContext['blobs'],
    lease: {} as StageContext['lease'],
    run: {
      id: scope.runId,
      owner_user_id: scope.ownerUserId,
      project_id: scope.projectId,
      input_revision: scope.inputRevision,
      input_hash: scope.inputHash,
      task_kind: 'generation',
    },
    signal: new AbortController().signal,
    checkpoint: {},
    values: new Map(),
  };
}

test('a missing or absent generation issuer binding pauses at the identity gate', async () => {
  for (const loadApprovedIssuerBinding of [async () => null, undefined]) {
    const stage = noHistoryModelGenerationStage(adapters({ loadApprovedIssuerBinding }));
    assert.deepEqual(await stage.run(context()), {
      kind: 'pause',
      stage: 'capability_not_ready',
      reason: 'needs_review:issuer_identity_not_bound',
    });
  }
});

test('a binding for another owner/run/input never authorizes this generation run', async () => {
  const mismatches: Array<Partial<ApprovedGenerationIssuerBinding>> = [
    { ownerUserId: 'other-owner' },
    { projectId: 'other-project' },
    { runId: 'other-run' },
    { inputHash: 'f'.repeat(64) },
    { inputRevision: scope.inputRevision + 1 },
    { contentSha256: 'not-a-hash' },
  ];
  for (const mismatch of mismatches) {
    const stage = noHistoryModelGenerationStage(
      adapters({ loadApprovedIssuerBinding: async () => ({ ...approved, ...mismatch }) }),
    );
    assert.deepEqual(
      await stage.run(context()),
      {
        kind: 'pause',
        stage: 'capability_not_ready',
        reason: 'needs_review:issuer_identity_not_bound',
      },
      JSON.stringify(mismatch),
    );
  }
});

test('an approved binding for this exact input passes the identity gate to reference selection', async () => {
  const stage = noHistoryModelGenerationStage(adapters());
  assert.deepEqual(await stage.run(context()), {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'needs_review:reference_selection_needs_review',
  });
});

test('a withdrawn or re-parsed binding pauses before the persisted prompt can reach a model', async () => {
  let reads = 0;
  const stage = noHistoryModelGenerationStage(
    adapters({
      loadApprovedIssuerBinding: async () => {
        reads++;
        return reads === 1 ? approved : null;
      },
      loadUserReferenceOutline: async () => ({
        status: 'accepted',
        outline: {
          schema_version: 'user-reference-outline-v1',
          owner_user_id: scope.ownerUserId,
          project_id: scope.projectId,
          run_id: scope.runId,
          input_revision: scope.inputRevision,
          input_hash: scope.inputHash,
          material_id: 'synthetic-reference',
          material_version: 1,
          material_sha256: 'd'.repeat(64),
          parse_snapshot_id: 'synthetic-snapshot',
          review_id: 'synthetic-review',
          fact_isolation_check_version: 'synthetic-v1',
          chapters: [{ order: 1, heading: '发行概况' }],
        },
      }),
    }),
  );
  const ctx = context();
  ctx.validateBeforeModelCall = async () => null;
  assert.deepEqual(await stage.run(ctx), {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'issuer_identity_not_bound',
  });
  assert.ok(reads >= 2, 'the binding is re-read before the model call');
});

const pinnedEntityId = 'entity:11111111-1111-4111-8111-111111111111';
const issuerMaterial = {
  material_id: 'target-audit',
  material_version: 1,
  role: 'audit',
  sha256: '1'.repeat(64),
};
const lockedBindingRef = {
  binding_id: 'locked-binding',
  version: 1,
  content_sha256: '2'.repeat(64),
};
const pinnedManifest = {
  kind: 'generation',
  materials: [issuerMaterial],
  generation_issuer_binding_ref: lockedBindingRef,
  generation_issuer_entity_id: pinnedEntityId,
};
const pinnedHash = inputManifestHash(pinnedManifest);

function lockedBindingResponse(
  overrides: Partial<GenerationIssuerBindingResponse> = {},
): GenerationIssuerBindingResponse {
  return {
    schema_version: 'generation-issuer-binding-v1',
    binding_id: lockedBindingRef.binding_id,
    version: lockedBindingRef.version,
    content_sha256: lockedBindingRef.content_sha256,
    owner_user_id: scope.ownerUserId,
    project_id: scope.projectId,
    input_revision: scope.inputRevision,
    input_hash: pinnedHash,
    selected_materials: [
      {
        material_id: issuerMaterial.material_id,
        material_version: issuerMaterial.material_version,
        role: 'audit',
        material_sha256: issuerMaterial.sha256,
        parse_snapshot_id: 'snapshot-locked',
        parse_response_sha256: '3'.repeat(64),
        parse_coverage: 'complete',
        parse_warning_codes: [],
        identity_coverage: 'complete',
        identity_uncertainties: [],
      },
    ],
    material_decisions: [],
    disputes: [],
    status: 'approved',
    issuer_entity_id: pinnedEntityId,
    review_events: [
      {
        review_id: 'review-locked',
        action: 'approve',
        reason: 'synthetic',
        reviewer_user_id: 'reviewer-locked',
        reviewer_grant_id: 'grant-locked',
        authority: 'issuer_identity_reviewer',
        binding_version: lockedBindingRef.version,
        binding_content_sha256: lockedBindingRef.content_sha256,
        reviewed_at: '2026-09-25T00:00:00Z',
      },
    ],
    created_at: '2026-09-25T00:00:00Z',
    ...overrides,
  };
}

function lockedAdapters(
  hash: string,
  verify?: VerifyPinnedBinding,
  overrides: Partial<NoHistoryStageAdapters> = {},
): NoHistoryStageAdapters {
  const locked = { ...scope, inputHash: hash };
  return adapters({
    loadReviewedIssuerProfile: async () => ({ ...reviewedProfile, ...locked }),
    loadTargetFacts: async () => ({
      ...locked,
      facts: [
        {
          factId: 'target-fact-1',
          statement: '目标发行人主营业务收入已核实。',
          evidenceRefs: ['target-audit-p1'],
          status: 'verified' as const,
        },
      ],
    }),
    loadTrustedRuleSelection: async () => ({ ...rule, ...locked }),
    loadApprovedIssuerBinding: undefined,
    verifyPinnedIssuerBinding: verify,
    ...overrides,
  });
}

function lockedContext(
  hash: string,
  manifest: unknown,
  rows?: Record<string, unknown>[],
): StageContext {
  const ctx = context();
  ctx.run.input_hash = hash;
  ctx.pool = {
    query: async () => ({ rows: rows ?? [{ manifest, input_hash: hash }] }),
  } as unknown as StageContext['pool'];
  return ctx;
}

test('the default locked-manifest loader re-verifies the pinned ref and reaches reference selection', async () => {
  let seenRef: unknown;
  const stage = noHistoryModelGenerationStage(
    lockedAdapters(pinnedHash, async (ref) => {
      seenRef = ref;
      return lockedBindingResponse();
    }),
  );
  assert.deepEqual(await stage.run(lockedContext(pinnedHash, pinnedManifest)), {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'needs_review:reference_selection_needs_review',
  });
  assert.deepEqual(seenRef, lockedBindingRef, 'the manifest pin is the only ref re-verified');
});

test('the default loader stays fail-closed without a manifest pin, malformed pin or failed re-verification', async () => {
  let verifyCalls = 0;
  const verify: VerifyPinnedBinding = async () => {
    verifyCalls++;
    return lockedBindingResponse();
  };
  const noPin = { kind: 'generation', materials: [issuerMaterial] };
  const malformedPin = {
    ...pinnedManifest,
    generation_issuer_binding_ref: { ...lockedBindingRef, content_sha256: 'not-a-hash' },
  };
  const wrongEntity = { ...pinnedManifest, generation_issuer_entity_id: 'browser-issuer-name' };
  const paused = {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'needs_review:issuer_identity_not_bound',
  } as const;
  for (const [description, hash, manifest] of [
    ['no pin', inputManifestHash(noPin), noPin],
    ['malformed pin', inputManifestHash(malformedPin), malformedPin],
    ['malformed pinned entity', inputManifestHash(wrongEntity), wrongEntity],
  ] as const) {
    const stage = noHistoryModelGenerationStage(lockedAdapters(hash, verify));
    assert.deepEqual(await stage.run(lockedContext(hash, manifest)), paused, description);
  }
  assert.equal(verifyCalls, 0, 'an invalid pin never reaches the re-verification boundary');

  for (const [description, verifyOverride] of [
    ['withdrawn binding', async () => null],
    [
      'entity conflict',
      async () =>
        lockedBindingResponse({ issuer_entity_id: 'entity:22222222-2222-4222-8222-222222222222' }),
    ],
    ['foreign project', async () => lockedBindingResponse({ project_id: 'other-project' })],
  ] as Array<[string, VerifyPinnedBinding]>) {
    const stage = noHistoryModelGenerationStage(lockedAdapters(pinnedHash, verifyOverride));
    assert.deepEqual(
      await stage.run(lockedContext(pinnedHash, pinnedManifest)),
      paused,
      description,
    );
  }
  const swapped = { ...pinnedManifest, materials: [{ ...issuerMaterial, sha256: '4'.repeat(64) }] };
  const swappedStage = noHistoryModelGenerationStage(
    lockedAdapters(pinnedHash, async () => lockedBindingResponse()),
  );
  assert.deepEqual(
    await swappedStage.run(lockedContext(pinnedHash, swapped)),
    paused,
    'a swapped issuer material stays fail closed',
  );
});
