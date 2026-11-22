// Synthetic intent and immutable host pins; never performs a model call or executes a task.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isReviewProposalV2,
  type ReviewAssistantReplyV2,
  type ReviewReport,
  type ReviewExecutionOrigin,
} from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import {
  reviewAssistantProtocol,
  reviewAssistantProposal,
  reviewAssistantReplyMetadata,
  reviewAssistantSnapshot,
  validReviewAssistantReply,
} from './review-assistant.js';
import { validReviewExecutionOrigin, type ReviewManifest } from './review-input.js';

const sha = 'a'.repeat(64),
  project = 'synthetic-project';
function fixture() {
  const source: ReviewReport = {
    report_id: 'source-report',
    project_id: project,
    run_id: 'source-run',
    version: 2,
    input_revision: 1,
    source_material: { material_id: 'source-material', material_version: 1, sha256: sha },
    scope: { mode: 'full_review', finding_ids: [] },
    findings: ['F1', 'F2', 'F3'].map((id) => ({
      finding_id: id,
      report_id: 'source-report',
      dimension: 'financial',
      conclusion: 'manual',
      severity: 'P2',
      title: id,
      description: 'Synthetic issue',
      target_refs: [],
      evidence_refs: [],
      limitations: [],
      repairability: { can_revise: false, reason: 'Needs verification', allowed_record_ids: [] },
      origin_report_id: 'source-report',
      check_status: 'rechecked',
    })),
    coverage: [],
    limitations: [],
    created_at: '2026-10-04T00:00:00Z',
  };
  const input = {
    source_material_ref: source.source_material,
    material_versions: [source.source_material],
    requirements: ['Original accepted requirement'],
    as_of: null,
  };
  const snapshot = {
    version: 'review-assistant-context-v2' as const,
    reply_schema_version: 'review-assistant-reply-v2' as const,
    report_catalog_version: 2,
    project: { issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private' },
    input: { version: 3, ...input },
    report: source,
    report_sha256: inputManifestHash(source),
    material_refs: [],
    prior_message_ids: [],
  };
  const reply: ReviewAssistantReplyV2 = {
    content: 'A proposed recheck awaits explicit adoption.',
    cited_finding_ids: ['F1'],
    proposal: {
      operation: 'differential_review',
      finding_ids: ['F1'],
      related_finding_ids: ['F2'],
      excluded_findings: [{ finding_id: 'F3', reason: 'Explicitly outside this check' }],
      requirements: ['Recheck the confirmed metric only'],
      explanation: 'Synthetic unexecuted proposal',
    },
  };
  const context = {
    project_id: project,
    report_id: source.report_id,
    finding_ids: ['F1'],
    material_refs: [],
  };
  const message = {
    id: 'message-1',
    project_id: project,
    content: 'Explain F1',
    context,
    context_snapshot: snapshot,
    request_hash: inputManifestHash({ project_id: project, content: 'Explain F1', context }),
  };
  return { input, snapshot, reply, message };
}

test('v2 context pins its own protocol and catalog while legacy messages keep v1', () => {
  const { message } = fixture();
  assert.equal(reviewAssistantSnapshot(message).report_catalog_version, 2);
  assert.equal(
    reviewAssistantProtocol(message.context_snapshot).logicalCallId,
    'review-assistant-v2',
  );
  assert.equal(
    reviewAssistantProtocol({ version: 'review-assistant-context-v1' }).logicalCallId,
    'review-assistant-v1',
  );
  assert.throws(
    () =>
      reviewAssistantProtocol({
        version: 'review-assistant-context-v1',
        reply_schema_version: 'review-assistant-reply-v2',
      }),
    /ASSISTANT_PROTOCOL_INVALID/,
  );
  for (const mutate of [
    (m: typeof message) => {
      delete (m.context_snapshot as any).reply_schema_version;
    },
    (m: typeof message) => {
      m.context_snapshot.report_catalog_version = -1;
    },
    (m: typeof message) => {
      m.context_snapshot.report_catalog_version = 1.5;
    },
  ]) {
    const bad = structuredClone(message);
    mutate(bad);
    assert.throws(() => reviewAssistantSnapshot(bad), /ASSISTANT_(?:CONTEXT|PROTOCOL)_INVALID/);
  }
});

test('typed proposals bind explicit selected, related and excluded scope and refuse model-authored authority', () => {
  const { snapshot, reply } = fixture();
  assert.equal(
    validReviewAssistantReply(reply, snapshot.report, 'review-assistant-reply-v2'),
    true,
  );
  for (const mutate of [
    (r: ReviewAssistantReplyV2) => {
      r.cited_finding_ids = ['foreign'];
    },
    (r: ReviewAssistantReplyV2) => {
      r.proposal!.related_finding_ids = ['F1'];
    },
    (r: ReviewAssistantReplyV2) => {
      r.proposal!.excluded_findings = [{ finding_id: 'F1', reason: 'Conflict' }];
    },
    (r: ReviewAssistantReplyV2) => {
      r.proposal!.related_finding_ids = ['foreign'];
    },
    (r: ReviewAssistantReplyV2) => {
      r.proposal!.operation = 'full_review';
    },
    (r: ReviewAssistantReplyV2) => {
      (r.proposal as any).source_report_sha256 = sha;
    },
    (r: ReviewAssistantReplyV2) => {
      (r as any).execute = true;
    },
    (r: ReviewAssistantReplyV2) => {
      r.proposal!.requirements = [' '];
    },
  ]) {
    const bad = structuredClone(reply);
    mutate(bad);
    assert.equal(
      validReviewAssistantReply(bad, snapshot.report, 'review-assistant-reply-v2'),
      false,
    );
  }
  const full = {
    ...reply,
    proposal: {
      ...reply.proposal!,
      operation: 'full_review' as const,
      finding_ids: [],
      related_finding_ids: [],
      excluded_findings: [],
    },
  };
  assert.equal(validReviewAssistantReply(full, snapshot.report, 'review-assistant-reply-v2'), true);
});

test('legacy result validation preserves 160-character finding identities without widening v2 model output', () => {
  const { snapshot } = fixture(),
    id = 'F'.repeat(160);
  snapshot.report.findings[0]!.finding_id = id;
  const reply = {
    content: 'Synthetic legacy reply',
    cited_finding_ids: [id],
    proposal: {
      finding_ids: [id],
      requirements: ['Accepted only after confirmation'],
      explanation: 'Legacy revision proposal',
    },
  };
  assert.equal(validReviewAssistantReply(reply, snapshot.report), true);
  const v2 = {
    ...reply,
    proposal: {
      ...reply.proposal,
      operation: 'revision',
      related_finding_ids: [],
      excluded_findings: [],
    },
  };
  assert.equal(validReviewAssistantReply(v2, snapshot.report, 'review-assistant-reply-v2'), false);
});

test('host supplies source, input, material and citation pins; full review keeps conversation reference separate', () => {
  const { input, snapshot, reply } = fixture(),
    proposal = reviewAssistantProposal(reply, snapshot, project, 'proposal-1');
  assert.equal(isReviewProposalV2(proposal), true);
  if (!isReviewProposalV2(proposal)) throw Error('v2 required');
  assert.equal(proposal.source_report_id, snapshot.report.report_id);
  assert.equal(proposal.source_report_sha256, inputManifestHash(snapshot.report));
  assert.equal(proposal.input_version, 3);
  assert.equal(proposal.input_sha256, inputManifestHash(input));
  assert.deepEqual(proposal.material_versions, input.material_versions);
  assert.deepEqual(reviewAssistantReplyMetadata(reply, snapshot), {
    version: 'review-reply-metadata-v1',
    context_report_ref: proposal.context_report_ref,
    cited_finding_ids: ['F1'],
  });
  const full = reviewAssistantProposal(
    {
      ...reply,
      proposal: {
        ...reply.proposal!,
        operation: 'full_review',
        finding_ids: [],
        related_finding_ids: [],
        excluded_findings: [],
      },
    },
    snapshot,
    project,
    'proposal-full',
  );
  if (!isReviewProposalV2(full)) throw Error('v2 required');
  assert.equal(full.source_report_id, null);
  assert.equal(full.source_report_sha256, null);
  assert.deepEqual(full.context_report_ref, proposal.context_report_ref);
});

function executionFixture() {
  const f = fixture(),
    proposal = reviewAssistantProposal(f.reply, f.snapshot, project, 'proposal-1');
  if (!isReviewProposalV2(proposal)) throw Error('v2 required');
  const input = { ...f.input, requirements: [...f.input.requirements, ...proposal.requirements] };
  const origin: ReviewExecutionOrigin = {
    version: 'review-execution-origin-v1',
    entrypoint: 'assistant_proposal',
    context_report_ref: proposal.context_report_ref,
    accepted_proposal: {
      acceptance_id: 'acceptance-1',
      proposal,
      proposal_sha256: inputManifestHash(proposal),
      adoption: 'as_proposed',
      accepted_at: '2026-10-04T01:00:00Z',
      input_version: 4,
      input_sha256: inputManifestHash(input),
      report_catalog_version: 2,
      finding_ids: ['F2', 'F1'],
      excluded_findings: proposal.excluded_findings,
      requirements: proposal.requirements,
    },
  };
  const review: ReviewManifest['review'] = {
    version: 'review_v1',
    operation: 'differential_review',
    report_id: 'new-report',
    version_number: 3,
    input,
    source_report_id: proposal.source_report_id,
    source_report_sha256: proposal.source_report_sha256,
    finding_ids: ['F1', 'F2'],
    draft_version: 4,
    origin,
  };
  return { review };
}

test('adopted input is hash-locked and the worker actually consumes its accepted requirements', () => {
  const { review } = executionFixture();
  assert.equal(validReviewExecutionOrigin(review, project), true);
  for (const mutate of [
    (r: typeof review) => {
      r.input.requirements = r.input.requirements.filter(
        (v) => v !== 'Recheck the confirmed metric only',
      );
      r.origin!.accepted_proposal!.input_sha256 = inputManifestHash(r.input);
    },
    (r: typeof review) => {
      r.origin!.accepted_proposal = null;
    },
    (r: typeof review) => {
      r.origin!.accepted_proposal!.input_version = 3;
    },
    (r: typeof review) => {
      r.source_report_id = 'foreign';
    },
    (r: typeof review) => {
      r.input.source_material_ref!.material_version = 2;
      r.origin!.accepted_proposal!.input_sha256 = inputManifestHash(r.input);
    },
    (r: typeof review) => {
      r.origin!.accepted_proposal!.proposal.project_id = 'foreign';
    },
    (r: typeof review) => {
      r.finding_ids = ['F1'];
    },
    (r: typeof review) => {
      r.origin!.accepted_proposal!.requirements = ['unadopted discussion'];
    },
    (r: typeof review) => {
      r.origin!.accepted_proposal!.adoption = 'invented' as any;
    },
    (r: typeof review) => {
      (r.origin as any).execute = true;
    },
  ]) {
    const bad = structuredClone(review);
    mutate(bad);
    assert.equal(validReviewExecutionOrigin(bad, project), false);
  }
  const adjusted = structuredClone(review);
  adjusted.origin!.accepted_proposal!.adoption = 'user_adjusted';
  adjusted.finding_ids = ['F1'];
  adjusted.origin!.accepted_proposal!.finding_ids = ['F1'];
  assert.equal(
    validReviewExecutionOrigin(adjusted, project),
    true,
    'explicitly accepted user adjustment remains valid',
  );
});

test('quick actions and immutable legacy manifests retain their own origin without adopting a discussion', () => {
  const { review } = executionFixture();
  delete review.origin;
  assert.equal(validReviewExecutionOrigin(review, project), true);
  review.origin = {
    version: 'review-execution-origin-v1',
    entrypoint: 'quick_action',
    accepted_proposal: null,
    context_report_ref: null,
  };
  assert.equal(validReviewExecutionOrigin(review, project), true);
  review.origin.entrypoint = 'legacy_unrecorded';
  assert.equal(validReviewExecutionOrigin(review, project), false);
  review.operation = 'full_review';
  review.origin.entrypoint = 'quick_action';
  assert.equal(validReviewExecutionOrigin(review, project), false);
  review.source_report_id = null;
  review.source_report_sha256 = null;
  review.finding_ids = [];
  assert.equal(validReviewExecutionOrigin(review, project), true);
});
