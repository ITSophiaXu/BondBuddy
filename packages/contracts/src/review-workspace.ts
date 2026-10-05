import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Project, Material, Run, RunEvent } from './index.js';
import type { ReviewReport } from './review-results.js';

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ maxLength: 12000 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const strict = <T extends Parameters<typeof Type.Object>[0]>(p: T) => Type.Object(p, { additionalProperties: false });
const nullableId = Type.Union([id, Type.Null()]);
const ids = Type.Array(id, { maxItems: 2000, uniqueItems: true });
const requirements = Type.Array(Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' }), { maxItems: 100 });
export const ReviewOperationSchema = Type.Union([Type.Literal('full_review'), Type.Literal('differential_review'), Type.Literal('revision')]);
export type ReviewOperation = Static<typeof ReviewOperationSchema>;
export const ReviewReportRefSchema = strict({ report_id: id, sha256: hash });
export type ReviewReportRef = Static<typeof ReviewReportRefSchema>;
const nullableReportRef = Type.Union([ReviewReportRefSchema, Type.Null()]);
export const ReviewExcludedFindingSchema = strict({ finding_id: id, reason: Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' }) });
const exclusions = Type.Array(ReviewExcludedFindingSchema, { maxItems: 2000 });
export const ReviewMaterialPinSchema = strict({ material_id: id, material_version: Type.Integer({ minimum: 1 }), sha256: hash });
export type ReviewMaterialPin = Static<typeof ReviewMaterialPinSchema>;
export const ReviewContextSchema = strict({ project_id: id, report_id: nullableId, finding_ids: Type.Array(id, { maxItems: 2000, uniqueItems: true }), material_refs: Type.Array(ReviewMaterialPinSchema, { maxItems: 60 }) });
export type ReviewContext = Static<typeof ReviewContextSchema>;
export const ReviewEvidenceLinkSchema = strict({ report_id: id, finding_id: id, material_ref: ReviewMaterialPinSchema });
export const ReviewDraftInputSchema = strict({ evidence_links: Type.Optional(Type.Array(ReviewEvidenceLinkSchema, { maxItems: 2000 })), source_material_ref: Type.Union([ReviewMaterialPinSchema, Type.Null()]), material_versions: Type.Array(ReviewMaterialPinSchema, { maxItems: 60 }), requirements: Type.Array(text, { maxItems: 100 }), as_of: Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()]) });
export type ReviewDraftInput = Static<typeof ReviewDraftInputSchema>;
export type ReviewDraft = ReviewDraftInput & { version: number };
export type ReviewMessageDraft = { context: ReviewContext; content: string; version: number; updated_at: string };
export const ReviewDraftRequestSchema = Type.Union([
  strict({ kind: Type.Literal('input'), expected_version: Type.Integer({ minimum: 0 }), input: ReviewDraftInputSchema }),
  strict({ kind: Type.Literal('message'), expected_version: Type.Integer({ minimum: 0 }), context: ReviewContextSchema, content: text }),
]);
export type ReviewDraftRequest = Static<typeof ReviewDraftRequestSchema>;
export const ReviewMessageRequestSchema = strict({ submission_request_id: id, content: Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' }), context: ReviewContextSchema });
export type ReviewMessageRequest = Static<typeof ReviewMessageRequestSchema>;
/** Persisted v1 proposals always meant revision. Their original shape remains readable. */
export type ReviewProposalLegacy = { proposal_id: string; source_report_id: string; finding_ids: string[]; requirements: string[]; explanation: string };
export const ReviewProposalV2Schema = strict({
  version: Type.Literal('review-proposal-v2'), proposal_id: id, project_id: id, operation: ReviewOperationSchema,
  source_report_id: nullableId, source_report_sha256: Type.Union([hash, Type.Null()]), context_report_ref: nullableReportRef,
  input_version: Type.Integer({ minimum: 0 }), input_sha256: hash,
  source_material_ref: Type.Union([ReviewMaterialPinSchema, Type.Null()]), material_versions: Type.Array(ReviewMaterialPinSchema, { maxItems: 60 }),
  finding_ids: ids, related_finding_ids: ids, excluded_findings: exclusions, requirements,
  explanation: Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' }),
});
export type ReviewProposalV2 = Static<typeof ReviewProposalV2Schema>;
export type ReviewProposal = ReviewProposalLegacy | ReviewProposalV2;
export function isReviewProposalV2(value: unknown): value is ReviewProposalV2 {
  if (!Value.Check(ReviewProposalV2Schema, value)) return false;
  const selected = [...value.finding_ids, ...value.related_finding_ids];
  return new Set(value.material_versions.map(pin => pin.material_id)).size === value.material_versions.length
    && new Set(selected).size === selected.length
    && new Set(value.excluded_findings.map(item => item.finding_id)).size === value.excluded_findings.length
    && value.excluded_findings.every(item => !selected.includes(item.finding_id))
    && (value.operation === 'full_review'
      ? value.source_report_id === null && value.source_report_sha256 === null && !selected.length && !value.excluded_findings.length
      : value.source_report_id !== null && value.source_report_sha256 !== null && selected.length > 0
        && value.context_report_ref?.report_id === value.source_report_id && value.context_report_ref.sha256 === value.source_report_sha256);
}
const legacyModelIds = Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 2000, uniqueItems: true });
const legacyModelProposal = strict({ finding_ids: legacyModelIds, requirements: Type.Array(Type.String({ minLength: 1, maxLength: 12000 }), { maxItems: 100 }), explanation: Type.String({ minLength: 1, maxLength: 12000 }) });
const modelProposalV2 = strict({ operation: ReviewOperationSchema, finding_ids: ids, related_finding_ids: ids, excluded_findings: exclusions, requirements, explanation: Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' }) });
/** Separate response schemas pin old logical calls; changing a UI does not resend them. */
export const ReviewAssistantReplyV1Schema = strict({ content: Type.String({ minLength: 1, maxLength: 12000 }), cited_finding_ids: legacyModelIds, proposal: Type.Union([legacyModelProposal, Type.Null()]) });
export const ReviewAssistantReplyV2Schema = strict({ content: Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' }), cited_finding_ids: ids, proposal: Type.Union([modelProposalV2, Type.Null()]) });
export type ReviewAssistantReplyV1 = Static<typeof ReviewAssistantReplyV1Schema>;
export type ReviewAssistantReplyV2 = Static<typeof ReviewAssistantReplyV2Schema>;
export const ReviewReplyMetadataSchema = strict({ version: Type.Literal('review-reply-metadata-v1'), context_report_ref: nullableReportRef, cited_finding_ids: legacyModelIds });
export type ReviewReplyMetadata = Static<typeof ReviewReplyMetadataSchema>;
export type ReviewMessage = { message_id: string; role: 'user' | 'assistant'; content: string; context: ReviewContext; created_at: string; reply_status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown'; reply_to: string | null; proposal: ReviewProposal | null; error: string | null; reply_metadata?: ReviewReplyMetadata | null };
export const ReviewProposalAdoptionRequestSchema = strict({ adoption_request_id: id, proposal_id: id, expected_input_version: Type.Integer({ minimum: 0 }), finding_ids: ids, excluded_findings: exclusions, requirements });
export type ReviewProposalAdoptionRequest = Static<typeof ReviewProposalAdoptionRequestSchema>;
export const ReviewAcceptedProposalSchema = strict({ acceptance_id: id, proposal: ReviewProposalV2Schema, proposal_sha256: hash,
  adoption: Type.Union([Type.Literal('as_proposed'), Type.Literal('user_adjusted')]),
  accepted_at: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' }),
  input_version: Type.Integer({ minimum: 1 }), input_sha256: hash, report_catalog_version: Type.Integer({ minimum: 0 }),
  finding_ids: ids, excluded_findings: exclusions, requirements });
export type ReviewAcceptedProposal = Static<typeof ReviewAcceptedProposalSchema>;
export const ReviewExecutionOriginSchema = strict({ version: Type.Literal('review-execution-origin-v1'),
  entrypoint: Type.Union([Type.Literal('quick_action'), Type.Literal('assistant_proposal'), Type.Literal('legacy_unrecorded')]),
  accepted_proposal: Type.Union([ReviewAcceptedProposalSchema, Type.Null()]), context_report_ref: nullableReportRef });
export type ReviewExecutionOrigin = Static<typeof ReviewExecutionOriginSchema>;
export const ReviewPlanRequestSchema = strict({ expected_version: Type.Integer({ minimum: 0 }), source_report_id: id, finding_ids: Type.Array(id, { maxItems: 2000, uniqueItems: true }), excluded_findings: Type.Array(strict({ finding_id: id, reason: Type.String({ minLength: 1, maxLength: 12000 }) }), { maxItems: 2000 }), requirements: Type.Array(text, { maxItems: 100 }), proposal_id: Type.Optional(id) });
export type ReviewPlanRequest = Static<typeof ReviewPlanRequestSchema>;
export type ReviewPlan = Omit<ReviewPlanRequest, 'expected_version' | 'proposal_id'> & { plan_id: string; version: number; sha256: string; accepted_at: string;
  proposal_origin?: { proposal: ReviewProposal; sha256: string; adoption: 'as_proposed' | 'user_adjusted' } };
export const ReviewExecutionRequestSchema = strict({ execution_request_id: id, operation: ReviewOperationSchema, expected_input_version: Type.Integer({ minimum: 1 }), source_report_id: nullableId, expected_plan_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), finding_ids: ids,
  entrypoint: Type.Optional(Type.Union([Type.Literal('quick_action'), Type.Literal('assistant_proposal')])), accepted_proposal_id: Type.Optional(id), context_report_ref: Type.Optional(nullableReportRef) });
export type ReviewExecutionRequest = Static<typeof ReviewExecutionRequestSchema>;
export type ReviewArtifact = { artifact_id: string; artifact_version: number; kind: 'report' | 'comments' | 'revision' | 'clean' | 'baseline'; filename: string };
export type ReviewProposalAdoptionResponse = { accepted_proposal: ReviewAcceptedProposal; draft: ReviewDraft; plan: ReviewPlan | null };
export type ReviewHistoryEntry = { run: Run; operation: ReviewExecutionRequest['operation']; version: number; source_report_id: string | null; report_id: string | null; input: ReviewDraftInput; input_revision: number; finding_ids: string[]; plan: ReviewPlan | null; origin?: ReviewExecutionOrigin; context_messages?: ReviewMessage[]; artifacts: ReviewArtifact[]; created_at: string };
export type ReviewTask = { run: Run; operation: ReviewOperation; version: number; input_version: number; input_revision: number; input_sha256: string; source_report_id: string | null; report_id: string | null; finding_ids: string[]; origin: ReviewExecutionOrigin; started_at?: string | null; completed_at?: string | null; artifacts: ReviewArtifact[]; events: RunEvent[] };
export type ReviewTimelineTask = ReviewTask;
export type ReviewTimelineEntry = { kind: 'message'; entry_id: string; created_at: string; message: ReviewMessage } | { kind: 'task'; entry_id: string; created_at: string; task: ReviewTask };
export type ReviewWorkspace = { project: Project; materials: Material[]; draft: ReviewDraft; message_drafts: ReviewMessageDraft[]; active_run: Run | null; selected_report: ReviewReport | null; reports: { report_id: string; version: number; run_id: string; created_at: string }[]; messages: ReviewMessage[]; timeline?: ReviewTimelineEntry[]; accepted_proposals?: ReviewAcceptedProposal[]; plan: ReviewPlan | null; artifacts: ReviewArtifact[]; artifact_run?: { source_run_id?: string | null; run_id: string; version: number; operation: ReviewExecutionRequest['operation']; source_report_id: string | null } | null };
