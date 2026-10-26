import {Type,type Static,type TObject,type TProperties} from '@sinclair/typebox';
import {ReviewMaterialPinSchema} from './review-workspace.js';
import {M1_UPLOAD_MATERIAL_ROLES} from './material-partitions.js';

const strict=<T extends TProperties>(properties:T):TObject<T>=>Type.Object(properties,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'});
const revision=Type.Integer({minimum:1});
const draftRevision=Type.Integer({minimum:0});
const nullableId=Type.Union([id,Type.Null()]);
const pin=ReviewMaterialPinSchema;

/** A preparation is separate from adoption; it cannot authorise execution or charges. */
export const RunSupplementMaterialSchema=strict({
 material_id:id,material_version:revision,sha256:hash,source_project_id:id,
 filename:Type.String({minLength:1}),role:Type.Union(M1_UPLOAD_MATERIAL_ROLES.map(role=>Type.Literal(role))),
 media_type:Type.String({minLength:1}),available:Type.Boolean(),
});
export const RunSupplementChangeSchema=strict({material:pin,replaces:Type.Union([pin,Type.Null()])});
export const RunSupplementDraftRequestSchema=strict({
 request_id:id,expected_revision:draftRevision,base_input_revision:revision,base_input_hash:hash,
 changes:Type.Array(RunSupplementChangeSchema,{maxItems:60}),
});
export const RunSupplementDraftQuerySchema=strict({request_id:Type.Optional(id)});
export const RunSupplementDraftResponseSchema=strict({
 run_id:id,project_id:id,revision:draftRevision,latest_revision:draftRevision,
 request_id:nullableId,saved_at:Type.Union([Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$'}),Type.Null()]),
 base_input_revision:revision,base_input_hash:hash,
 base_materials:Type.Array(RunSupplementMaterialSchema,{maxItems:240}),
 changes:Type.Array(RunSupplementChangeSchema,{maxItems:60}),
 result_materials:Type.Array(RunSupplementMaterialSchema,{maxItems:300}),
 can_save:Type.Boolean(),blocked_reason:Type.Union([Type.String({minLength:1,maxLength:1200}),Type.Null()]),
 adopted:Type.Literal(false),
});
export type RunSupplementMaterial=Static<typeof RunSupplementMaterialSchema>;
export type RunSupplementChange=Static<typeof RunSupplementChangeSchema>;
export type RunSupplementDraftRequest=Static<typeof RunSupplementDraftRequestSchema>;
export type RunSupplementDraftResponse=Static<typeof RunSupplementDraftResponseSchema>;
export const runSupplementSchemas={
 RunSupplementMaterial:RunSupplementMaterialSchema,RunSupplementChange:RunSupplementChangeSchema,
 RunSupplementDraftRequest:RunSupplementDraftRequestSchema,RunSupplementDraftQuery:RunSupplementDraftQuerySchema,
 RunSupplementDraftResponse:RunSupplementDraftResponseSchema,
};
