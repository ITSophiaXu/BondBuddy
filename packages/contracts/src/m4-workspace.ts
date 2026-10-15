import { AssistantActionSchema, AssistantViewSchema } from './project-assistant.js';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { MARKETS, OFFERINGS } from './public-enums.js';
import type { Project, Run, RunEvent } from './index.js';
import type { CreditBalance } from './billing.js';
import type { AuthoringProgress } from './authoring-progress.js';

const obj = <T extends Parameters<typeof Type.Object>[0]>(p: T) => Type.Object(p, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const text = Type.String({ maxLength: 12000 });
const nonempty = Type.String({ minLength: 1, maxLength: 12000, pattern: '\\S' });
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(s: T) => Type.Union([s, Type.Null()]);
const version = Type.Integer({ minimum: 1 });
export * from './m4-document-types.js';
import { M4DocumentTypeSchema,M4_DOCUMENT_BILLING_TASKS,type M4DocumentType } from './m4-document-types.js';
export const M4MaterialPinSchema = obj({ source_project_id: id, material_id: id, material_version: version, sha256: hash });
export type M4MaterialPin = Static<typeof M4MaterialPinSchema>;
export const M4ArtifactPinSchema = obj({ source_project_id: id, artifact_id: id, artifact_version: version, sha256: hash });
export type M4ArtifactPin = Static<typeof M4ArtifactPinSchema>;
export const M4CitationSchema = Type.Union([
  obj({ kind: Type.Literal('material'), ref: M4MaterialPinSchema, locator: nullable(text) }),
  obj({ kind: Type.Literal('artifact'), ref: M4ArtifactPinSchema, locator: nullable(text) }),
]);
export type M4Citation = Static<typeof M4CitationSchema>;
export const M4TemplateRefSchema = obj({ template_id: id, template_version: version, sha256: hash });
export type M4TemplateRef = Static<typeof M4TemplateRefSchema>;
export const M4RequirementSchema = obj({ requirement_id: id, text: nonempty, message_id: id, message_version: version });
export type M4Requirement = Static<typeof M4RequirementSchema>;
export const M4DraftInputSchema = obj({ document_type: M4DocumentTypeSchema,
  source_material: nullable(M4MaterialPinSchema), materials: Type.Array(M4MaterialPinSchema, { maxItems: 60 }),
  template: nullable(M4TemplateRefSchema), edit_base: nullable(M4ArtifactPinSchema), scope: Type.Literal('whole'),
  fields: Type.Record(Type.String({ maxLength: 80 }), Type.String({ maxLength: 2000 })),
  requirements: Type.Array(M4RequirementSchema, { maxItems: 100 }),
  supplemental_requirements: Type.Optional(text),
});
export type M4DraftInput = Static<typeof M4DraftInputSchema>;
export type M4Draft = M4DraftInput & { version: number; sha256: string; updated_at: string | null };
export const M4MessageContextSchema = obj({ document_type: nullable(M4DocumentTypeSchema),
  draft_version: Type.Integer({ minimum: 0 }), source_material: nullable(M4MaterialPinSchema),
  citations: Type.Array(M4CitationSchema, { maxItems: 60 }), reading_artifact: nullable(M4ArtifactPinSchema) });
export type M4MessageContext = Static<typeof M4MessageContextSchema>;
export const M4ViewStateSchema = obj({ assistant: Type.Optional(AssistantViewSchema), selected_document_type: nullable(M4DocumentTypeSchema),
  open_tabs: Type.Array(M4ArtifactPinSchema, { maxItems: 30 }), active_tab: nullable(M4ArtifactPinSchema),
  unsent_content: text, unsent_context: M4MessageContextSchema,
  workspace_tab: Type.Optional(Type.String({ maxLength: 200 })), making_run_ids: Type.Optional(Type.Array(id, { maxItems: 30 })),
  tab_scroll: Type.Optional(Type.Record(Type.String({ maxLength: 200 }), Type.Number({ minimum: 0 }))),
  quotation: Type.Optional(nullable(obj({ citation: M4CitationSchema, original_text: text, anchor: nullable(text) }))) });
export type M4ViewState = Static<typeof M4ViewStateSchema>;
export const M4TopicCreateRequestSchema = obj({ creation_request_id: id, name: Type.String({ minLength: 1, maxLength: 200 }),
  source_project_id: Type.Optional(id), surface: Type.Optional(Type.Union([Type.Literal('materials'),Type.Literal('assistant')])) });
export type M4TopicCreateRequest = Static<typeof M4TopicCreateRequestSchema>;
export const M4DraftRequestSchema = obj({ expected_version: Type.Integer({ minimum: 0 }), input: M4DraftInputSchema });
export type M4DraftRequest = Static<typeof M4DraftRequestSchema>;
export const M4ViewRequestSchema = obj({ expected_version: Type.Integer({ minimum: 0 }), view: M4ViewStateSchema });
export type M4ViewRequest = Static<typeof M4ViewRequestSchema>;
export const M4TemplateCreateRequestSchema = obj({ creation_request_id: id, name: Type.String({ minLength: 1, maxLength: 200 }),
  broker: Type.String({ maxLength: 200 }), document_type: M4DocumentTypeSchema, material: M4MaterialPinSchema,
  market: Type.Optional(Type.Union([Type.Literal('sse'), Type.Literal('szse')])),
  replaces_template_id: Type.Optional(id) });
export type M4TemplateCreateRequest = Static<typeof M4TemplateCreateRequestSchema>;
export type M4Template = M4TemplateRef & { name: string; broker: string; document_type: M4DocumentType;
  material: M4MaterialPin; owner_scope: 'private'; market: 'sse' | 'szse'; offering: 'private'; status: 'active' | 'retired'; created_at: string; retired_at: string | null };
export const M4MessageRequestSchema = obj({ submission_request_id: id, content: nonempty, context: M4MessageContextSchema,
  quote_id: Type.Optional(id), execute: Type.Optional(Type.Boolean()) });
export type M4MessageRequest = Static<typeof M4MessageRequestSchema>;
export const M4HandoffBindRequestSchema = obj({ message_id: id, message_version: version,
  target_project_id: id, source_material: M4MaterialPinSchema });
export type M4HandoffBindRequest = Static<typeof M4HandoffBindRequestSchema>;
export const M4HandoffBindResponseSchema = obj({ binding: obj({ topic_id: id, message_id: id,
  message_version: version, target_project_id: id, source_material: M4MaterialPinSchema,
  execution_scope_project_id: id }) });
export type M4HandoffBindResponse = Static<typeof M4HandoffBindResponseSchema>;
export const M4QuoteRequestSchema = Type.Union([
  obj({ kind: Type.Literal('document'), document_type: M4DocumentTypeSchema, expected_draft_version: version }),
  obj({ kind: Type.Literal('qa'), content: nonempty, context: M4MessageContextSchema }),
]);
export type M4QuoteRequest = Static<typeof M4QuoteRequestSchema>;
export const M4ExecuteRequestSchema = obj({ execution_request_id: id, document_type: M4DocumentTypeSchema,
  expected_draft_version: version, quote_id: id, entrypoint: Type.Union([Type.Literal('workspace'), Type.Literal('assistant')]) });
export type M4ExecuteRequest = Static<typeof M4ExecuteRequestSchema>;
export const M4_BILLING_TASKS = { m4_G01: '立项报告', m4_G02: '主承销商核查意见', m4_G03: '法律意见书', m4_G05: '募集说明书摘要', m4_G04:'推荐函', m4_application:'申请书', m4_Q01: '通用解释',
  m4_Q02: '授权资料定位', m4_Q03: '确定性计算', m4_Q04: '基础资料比较', m4_Q05: '基础资料解读' } as const;
export type M4BillingTask = keyof typeof M4_BILLING_TASKS;
export const M4_DOCUMENT_FIXED_PRICE = { version: 'm4-document-fixed-20261008-v1', points: 4500 } as const;
export type M4Quote = { quote_id: string; topic_id: string; input_hash: string; task_type: M4BillingTask | 'm4_Q00' | 'm4_task_assistance';
  points: number; price_version: string | null; reason: string; created_at: string;
  billing_policy?: 'on_delivery' | 'authoring_balance_v2';
  billing_method: 'fixed' | 'metered_capped' | 'free'; multiplier: number; expires_at: string; amount_semantics: 'fixed_price' | 'reservation_cap' };
export type M4QuoteResponse = { quote: M4Quote; balance: CreditBalance; shortage: number };
export const M4CaseTemplateSchema = obj({id,version:id,sha256:hash,
  docx_base64:Type.String({minLength:1,maxLength:2000000,pattern:'^[A-Za-z0-9+/]+={0,2}$'})});
export const M4KnowledgeSnapshotSchema = obj({version:id,document_type:M4DocumentTypeSchema,
  market:Type.Union(MARKETS.map(v=>Type.Literal(v))),offering:Type.Optional(Type.Union(OFFERINGS.map(v=>Type.Literal(v)))),
  template:Type.Optional(M4CaseTemplateSchema),title:nonempty,sha256:hash,
  source_ids:Type.Array(id,{minItems:1,maxItems:20}),content:Type.String({minLength:1,maxLength:500000})});
export type M4KnowledgeSnapshot = Static<typeof M4KnowledgeSnapshotSchema>;
export const M4DocumentManifestSchema = obj({ version: Type.Literal('m4-document-input-v1'), kind: Type.Literal('document'),
  project_name: Type.Optional(Type.String({ maxLength: 200 })),
  topic_id: id, execution_scope_project_id: id, draft_version: version, input: M4DraftInputSchema,
  template_material: nullable(M4MaterialPinSchema), market: Type.Union(MARKETS.map(v=>Type.Literal(v))),
  // Optional only for persisted pre-knowledge v1 tasks; the API pins it on every new task.
  knowledge:Type.Optional(M4KnowledgeSnapshotSchema),
  offering: Type.Union([Type.Literal('private'),Type.Literal('ppn'),Type.Literal('mtn')]), billing_task: Type.Union(Object.values(M4_DOCUMENT_BILLING_TASKS).map(v=>Type.Literal(v))) });
export type M4DocumentManifest = Static<typeof M4DocumentManifestSchema>;
export const M4QaManifestSchema = obj({ version: Type.Literal('m4-qa-input-v1'), kind: Type.Literal('qa'),
  topic_id: id, message_id: id, content: nonempty, context: M4MessageContextSchema,
  assistant_context: Type.Optional(obj({ project_id: nullable(id), project_name: text, issuer_name: text, market: text, offering: text, reporting_cutoff: text, action: nullable(AssistantActionSchema) })),
  context_snapshot: obj({ draft: nullable(M4DraftInputSchema), messages: Type.Array(obj({ message_id: id, version, role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]), content: text }), { maxItems: 200 }),
    quotation: Type.Optional(nullable(obj({ citation: M4CitationSchema, original_text: text, anchor: nullable(text) }))) }),
  materials: Type.Array(M4MaterialPinSchema, { maxItems: 60 }),
  execution_proposal: Type.Optional(obj({document_type:M4DocumentTypeSchema,expected_draft_version:version,quote_id:id})),
  billing_task: Type.Union([Type.Literal('m4_Q00'), Type.Literal('m4_task_assistance'), ...Object.keys(M4_BILLING_TASKS).filter(k => k.startsWith('m4_Q')).map(k => Type.Literal(k as M4BillingTask))]) });
export type M4QaManifest = Static<typeof M4QaManifestSchema>;
export const M4ManifestSchema = Type.Union([M4DocumentManifestSchema, M4QaManifestSchema]);
export type M4Manifest = Static<typeof M4ManifestSchema>;
export const isM4Manifest = (v: unknown): v is M4Manifest => Value.Check(M4ManifestSchema, v);
export const M4AssistantReplySchema = obj({ assistant_action: Type.Optional(AssistantActionSchema), content: nonempty, citations: Type.Array(M4CitationSchema, { maxItems: 60 }),
  requirements: Type.Array(nonempty, { maxItems: 100 }),
  fields: Type.Record(Type.String({ maxLength: 80 }), Type.String({ maxLength: 2000 })),
  intent: Type.Union([Type.Literal('answer'), Type.Literal('clarify'), Type.Literal('draft'), Type.Literal('execute'), Type.Literal('cross_business')]),
  document_type: nullable(M4DocumentTypeSchema), target_business: nullable(Type.Union([Type.Literal('update'), Type.Literal('review'), Type.Literal('generation')])),
  retrieval: Type.Literal('not_performed') });
export type M4AssistantReply = Static<typeof M4AssistantReplySchema>;
export type M4Message = { message_id: string; role: 'user' | 'assistant'; content: string; version: number;
  context: M4MessageContext; created_at: string; reply_status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
  reply_to: string | null; run_id: string | null; reply: M4AssistantReply | null; error: string | null };
export type M4Artifact = M4ArtifactPin & { topic_id: string; run_id: string; document_type: M4DocumentType | null;
  kind: 'document' | 'preparation_note' | 'qa_text'; filename: string; mime_type: string; byte_size: number; created_at: string;
  base_artifact: M4ArtifactPin | null; input_hash: string; revision_number: number | null };
export type M4CreditCharge = {quote: M4Quote | null; state: 'held' | 'settled' | 'released' | null; progress?: AuthoringProgress};
export type M4Task = { credit_charge?: M4CreditCharge; run: Run; manifest: M4Manifest; created_at: string; events: RunEvent[]; artifacts: M4Artifact[] };
export type M4Topic = { surface?: 'materials'|'assistant'; topic_id: string; project_id: string; source_project_id: string | null; name: string; created_at: string; updated_at: string };
export type M4Workspace = { topic: M4Topic; project: Project; drafts: Record<M4DocumentType, M4Draft>;
  materials: M4MaterialPin[]; material_details: (M4MaterialPin & {filename: string; state: string; media_type: string; role?:string})[];
  templates: M4Template[]; messages: M4Message[]; tasks: M4Task[]; artifacts: M4Artifact[];
  pending_requirements: M4Requirement[];
  view: M4ViewState & { version: number }; active_run: Run | null };
export const m4Schemas = { M4TopicCreateRequest: M4TopicCreateRequestSchema, M4DraftRequest: M4DraftRequestSchema,
  M4ViewRequest: M4ViewRequestSchema, M4TemplateCreateRequest: M4TemplateCreateRequestSchema,
  M4MessageRequest: M4MessageRequestSchema, M4QuoteRequest: M4QuoteRequestSchema, M4ExecuteRequest: M4ExecuteRequestSchema,
  M4HandoffBindRequest: M4HandoffBindRequestSchema, M4HandoffBindResponse: M4HandoffBindResponseSchema };
export const M4_API_BASE = '/api/v1/m4';
