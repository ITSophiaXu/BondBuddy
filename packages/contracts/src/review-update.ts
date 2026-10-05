import { Type, type Static } from '@sinclair/typebox';
const id=Type.String({minLength:1,maxLength:128});
export const ReviewUpdateRequestSchema=Type.Object({execution_request_id:id,source_run_id:id,requirements:Type.String({maxLength:6000})},{additionalProperties:false});
export type ReviewUpdateRequest=Static<typeof ReviewUpdateRequestSchema>;
/** A completed review file is evidence to consider, never an instruction to blindly apply every finding. */
export const ReviewResultPinSchema=Type.Object({version:Type.Literal('review-result-v1'),run_id:id,input_revision:Type.Integer({minimum:1}),
  input_hash:Type.String({pattern:'^[a-f0-9]{64}$'}),artifact_id:id,artifact_version:Type.Integer({minimum:1}),sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),
  source_material:Type.Object({material_id:id,material_version:Type.Integer({minimum:1}),sha256:Type.String({pattern:'^[a-f0-9]{64}$'})},{additionalProperties:false}),
  requirements:Type.String({maxLength:6000})},{additionalProperties:false});
export type ReviewResultPin=Static<typeof ReviewResultPinSchema>;
