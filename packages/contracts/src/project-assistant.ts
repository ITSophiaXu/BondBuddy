import { Type, type Static } from '@sinclair/typebox';
import { M4DocumentTypeSchema } from './m4-document-types.js';
import type { M4ArtifactPin, M4Quote, Run } from './index.js';
import type { CreditBalance, FixedQuote } from './billing.js';
import { MARKETS, OFFERINGS } from './public-enums.js';
import { SourceProspectusSchema } from './update-project.js';

const obj = <T extends Parameters<typeof Type.Object>[0]>(p:T) => Type.Object(p,{additionalProperties:false});
const id = Type.String({minLength:1,maxLength:128});
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(s:T) => Type.Union([s,Type.Null()]);
export const AssistantActionSchema = obj({
  business: Type.Union([Type.Literal('update'),Type.Literal('review'),Type.Literal('generation')]),
  requirements: Type.String({maxLength:12000}),
  fields: obj({
    broker:Type.Optional(Type.String({maxLength:200})), name: Type.Optional(Type.String({maxLength:120})), issuer_name: Type.Optional(Type.String({maxLength:200})),
    market: Type.Optional(Type.Union(MARKETS.map(x=>Type.Literal(x)))),
    offering: Type.Optional(Type.Union(OFFERINGS.map(x=>Type.Literal(x)))),
    reporting_cutoff: Type.Optional(Type.String({pattern:'^\\d{4}-(03-31|06-30|09-30|12-31)$'})),
    document_type: Type.Optional(M4DocumentTypeSchema),
  }),
});
export type AssistantAction = Static<typeof AssistantActionSchema>;
export const AssistantViewSchema = obj({copy_source_project_id:Type.Optional(id),draft_token:Type.Optional(id),prepared_card_id:Type.Optional(id),project_creation_request_id:Type.Optional(id),template_key:Type.Optional(id),
  source_prospectuses:Type.Optional(Type.Array(SourceProspectusSchema,{maxItems:60})),project_id:nullable(id),action:nullable(AssistantActionSchema)});
export type AssistantView = Static<typeof AssistantViewSchema>;
export const AssistantCardRequestSchema = obj({
  card_id:id, operation:Type.Union([Type.Literal('update'),Type.Literal('review'),Type.Literal('generation')]),
  project_id:id, execution_request_id:id, quote_id:Type.Optional(id),
  input_revision:Type.Optional(Type.Integer({minimum:1})),input_hash:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'})),
  expected_input_version:Type.Optional(Type.Integer({minimum:1})),
  document_type:Type.Optional(M4DocumentTypeSchema),
  expected_draft_version:Type.Optional(Type.Integer({minimum:1})),
});
export type AssistantCardRequest = Static<typeof AssistantCardRequestSchema>;
export type AssistantCard = AssistantCardRequest & {
  draft_token:string|null; target:{issuer_name:string;market:string;offering:string;reporting_cutoff:string}; created_at:string; project_name:string; requirements:string; material_names:string[];
  baseline:M4ArtifactPin|null; quote:FixedQuote|M4Quote|null; balance:CreditBalance; run:Run|null;
};
export type AssistantResult = {pin:M4ArtifactPin;run_id:string;filename:string;label:string;created_at:string};
