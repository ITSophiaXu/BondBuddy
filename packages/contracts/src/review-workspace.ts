import { Type, type Static } from '@sinclair/typebox';
import type { Project, Material, Run } from './index.js';
import type { ReviewReport } from './review-results.js';

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ maxLength: 12000 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const strict = <T extends Parameters<typeof Type.Object>[0]>(p: T) => Type.Object(p, { additionalProperties: false });
const nullableId = Type.Union([id, Type.Null()]);
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
export type ReviewProposal = { proposal_id: string; source_report_id: string; finding_ids: string[]; requirements: string[]; explanation: string };
export type ReviewMessage = { message_id: string; role: 'user' | 'assistant'; content: string; context: ReviewContext; created_at: string; reply_status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown'; reply_to: string | null; proposal: ReviewProposal | null; error: string | null };
export const ReviewPlanRequestSchema = strict({ expected_version: Type.Integer({ minimum: 0 }), source_report_id: id, finding_ids: Type.Array(id, { maxItems: 2000, uniqueItems: true }), excluded_findings: Type.Array(strict({ finding_id: id, reason: Type.String({ minLength: 1, maxLength: 12000 }) }), { maxItems: 2000 }), requirements: Type.Array(text, { maxItems: 100 }), proposal_id: Type.Optional(id) });
export type ReviewPlanRequest = Static<typeof ReviewPlanRequestSchema>;
export type ReviewPlan = Omit<ReviewPlanRequest, 'expected_version' | 'proposal_id'> & { plan_id: string; version: number; sha256: string; accepted_at: string;
  proposal_origin?: { proposal: ReviewProposal; sha256: string; adoption: 'as_proposed' | 'user_adjusted' } };
export const ReviewExecutionRequestSchema = strict({ execution_request_id: id, operation: Type.Union([Type.Literal('full_review'), Type.Literal('differential_review'), Type.Literal('revision')]), expected_input_version: Type.Integer({ minimum: 1 }), source_report_id: nullableId, expected_plan_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), finding_ids: Type.Array(id, { maxItems: 2000, uniqueItems: true }) });
export type ReviewExecutionRequest = Static<typeof ReviewExecutionRequestSchema>;
export type ReviewArtifact = { artifact_id: string; artifact_version: number; kind: 'report' | 'comments' | 'revision' | 'clean' | 'baseline'; filename: string };
export type ReviewHistoryEntry = { run: Run; operation: ReviewExecutionRequest['operation']; version: number; source_report_id: string | null; report_id: string | null; input: ReviewDraftInput; input_revision: number; finding_ids: string[]; plan: ReviewPlan | null; context_messages?: ReviewMessage[]; artifacts: ReviewArtifact[]; created_at: string };
export type ReviewWorkspace = { project: Project; materials: Material[]; draft: ReviewDraft; message_drafts: ReviewMessageDraft[]; active_run: Run | null; selected_report: ReviewReport | null; reports: { report_id: string; version: number; run_id: string; created_at: string }[]; messages: ReviewMessage[]; plan: ReviewPlan | null; artifacts: ReviewArtifact[]; artifact_run?: { run_id: string; version: number; operation: ReviewExecutionRequest['operation']; source_report_id: string | null } | null };
