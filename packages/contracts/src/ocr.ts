import { Type, type Static, type TSchema } from '@sinclair/typebox';
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const positive = Type.Integer({ minimum: 1 });
const text = Type.String({ maxLength: 16000 });
const nullableText = Type.Union([text, Type.Null()]);
const warnings = Type.Array(Type.String({ maxLength: 200 }), { maxItems: 30 });
export const OcrRecordSchema = object({
  record_id: id, page: positive,
  bbox: Type.Tuple([Type.Number({minimum:0}),Type.Number({minimum:0}),Type.Number({minimum:0}),Type.Number({minimum:0})]),
  text, confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  numeric: object({ kind: Type.Union(['number','blank','dash','unparsed'].map(v=>Type.Literal(v))), decimal: nullableText, unit: nullableText }),
  cell: Type.Union([object({ table_id: id, row: positive, column: positive, row_span: positive, column_span: positive }),Type.Null()]),
  uncertainty: warnings, eligible_for_manuscript: Type.Literal(false)
});
export const OcrPageSchema = object({
  page: positive, width: Type.Integer({minimum:1,maximum:20000}), height: Type.Integer({minimum:1,maximum:20000}),
  rotation_clockwise: Type.Union([0,90,180,270].map(v=>Type.Literal(v))), coordinate_system: Type.Literal('rendered_pixels_top_left'),
  image_sha256: hash, image_base64: Type.String({maxLength:64*1024*1024}), warnings
});
export const OcrEngineResponseSchema = object({
  schema_version: Type.Literal('ocr-response-v1'), request_id: id, processor_version: Type.String({maxLength:100}),
  engine_version: Type.String({maxLength:100}), language_data_sha256: Type.Record(Type.String(),hash), language: Type.String({maxLength:100}),
  purpose: Type.Union([Type.Literal('source_preflight'),Type.Literal('full_ocr')]),
  status: Type.Union([Type.Literal('needs_confirmation'),Type.Literal('failed')]),
  material: object({material_id:id,material_version:positive,media_type:Type.String(),sha256:hash}),
  page_count: Type.Integer({minimum:0,maximum:1500}), coverage: Type.Union(['none','partial','complete'].map(v=>Type.Literal(v))),
  // Pages passed to the OCR engine, retained even when a later page fails.
  attempted_pages: Type.Optional(Type.Integer({minimum:0,maximum:50})),
  pages: Type.Array(OcrPageSchema,{maxItems:50}), records: Type.Array(OcrRecordSchema,{maxItems:100000}), warnings,
  error: nullableText, eligible_for_manuscript: Type.Literal(false)
});
export const OcrCorrectionRequestSchema = object({
  request_id:id, snapshot_id:id, record_id:id, result_sha256:hash,
  expected_revision:Type.Integer({minimum:0}), corrected_text:Type.String({maxLength:4000}),
  reason:Type.String({minLength:1,maxLength:2000}), period:nullableText, scope:nullableText, unit:nullableText
});
export const OcrCorrectionSchema = object({
  correction_id:id, record_id:id, revision:positive, original_text:text, corrected_text:text, reason:text,
  period:nullableText, scope:nullableText, unit:nullableText,
  actor_user_id:id, created_at:Type.String(), status:Type.Literal('user_asserted'), eligible_for_manuscript:Type.Literal(false)
});
export const OcrReviewSchema = object({
  snapshot_id:id,result_sha256:hash,material_id:id,material_version:positive,purpose:Type.Union([Type.Literal('source_preflight'),Type.Literal('full_ocr')]),
  coverage:Type.Union([Type.Literal('partial'),Type.Literal('complete')]),page_count:positive,
  pages:Type.Array(object({...Type.Omit(OcrPageSchema,['image_base64']).properties,image_url:Type.String()})),
  records:Type.Array(OcrRecordSchema), corrections:Type.Array(OcrCorrectionSchema), warnings,
  eligible_for_manuscript:Type.Literal(false)
});
export type OcrEngineResponse = Static<typeof OcrEngineResponseSchema>;
export type OcrReview = Static<typeof OcrReviewSchema>;
export type OcrCorrectionRequest = Static<typeof OcrCorrectionRequestSchema>;
export type OcrCorrection = Static<typeof OcrCorrectionSchema>;

// Internal v2 contract only: no v1 processor, HTTP route or durable snapshot is upgraded.
export const OCR_V2_LIMITS = { batch_pages: 50, preflight_pages: 5, document_pages: 1500, page_pixels: 20_000_000 } as const;
const version = Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' });
const physicalPage = Type.Integer({ minimum: 1, maximum: OCR_V2_LIMITS.document_pages });
export const OcrDocumentIdentityV2Schema = object({
  owner_user_id: id, project_id: id,
  material: OcrEngineResponseSchema.properties.material,
  page_count: physicalPage, processor_version: version,
  engine: object({
    name: version, version, language: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z_]+(?:\\+[a-z_]+)*$' }),
    language_data_sha256: Type.Record(Type.String({ pattern: '^[a-z_]+$' }), hash, { minProperties: 1 }),
    parameters_sha256: hash
  }),
  rendering: object({
    renderer: version, renderer_version: version, dpi: Type.Integer({ minimum: 1, maximum: 1200 }),
    max_page_pixels: Type.Integer({ minimum: 1, maximum: OCR_V2_LIMITS.page_pixels }),
    parameters_sha256: hash
  })
});
export const OcrPageIdentityV2Schema = object({ document: OcrDocumentIdentityV2Schema, page: physicalPage });
export const OcrPageResultV2Schema = object({
  page: Type.Omit(OcrPageSchema, ['image_base64']),
  records: Type.Array(OcrRecordSchema, { maxItems: 100000 }),
  status: Type.Literal('needs_confirmation'), eligible_for_manuscript: Type.Literal(false)
});
export const OcrPageCheckpointV2Schema = object({
  schema_version: Type.Literal('ocr-page-checkpoint-v2'),
  identity: OcrPageIdentityV2Schema, identity_sha256: hash, result_sha256: hash,
  source_request_id: id, result: OcrPageResultV2Schema
});
export const OcrCheckpointRefV2Schema = object({
  page: physicalPage, identity_sha256: hash, result_sha256: hash, source_request_id: id
});
const trialCost = { billable: Type.Literal(false), cost_payer: Type.Literal('platform') };
export const OcrExecutionContextV2Schema = Type.Union([
  object({ purpose: Type.Literal('source_preflight'), run: Type.Null(), ...trialCost }),
  object({
    purpose: Type.Literal('full_ocr'),
    run: object({ run_id: id, execution_request_id: id, input_revision: positive, input_hash: hash }),
    ...trialCost
  })
]);
export const OcrBatchRequestV2Schema = object({
  schema_version: Type.Literal('ocr-request-v2'), request_id: id,
  document: OcrDocumentIdentityV2Schema, context: OcrExecutionContextV2Schema,
  pages: Type.Array(physicalPage, { minItems: 1, maxItems: OCR_V2_LIMITS.batch_pages, uniqueItems: true }),
  reuse: Type.Array(OcrCheckpointRefV2Schema, { maxItems: OCR_V2_LIMITS.batch_pages })
});
export const OcrBatchResponseV2Schema = object({
  schema_version: Type.Literal('ocr-response-v2'), request_id: id,
  document: OcrDocumentIdentityV2Schema, context: OcrExecutionContextV2Schema,
  page_results: Type.Array(Type.Union([
    object({ page: physicalPage, status: Type.Literal('succeeded'), reused: Type.Boolean(), checkpoint: OcrCheckpointRefV2Schema }),
    object({
      page: physicalPage, status: Type.Literal('failed'),
      attempted: Type.Union([Type.Boolean(), Type.Null()]), retryable: Type.Boolean(),
      error: Type.String({ minLength: 1, maxLength: 200 }), warnings
    })
  ]), { minItems: 1, maxItems: OCR_V2_LIMITS.batch_pages }),
  // One page attempt per batch, including failures; null means its consumption is unknown.
  attempted_pages: Type.Union([Type.Integer({ minimum: 0, maximum: OCR_V2_LIMITS.batch_pages }), Type.Null()]),
  coverage: Type.Union([Type.Literal('none'), Type.Literal('partial')]),
  eligible_for_manuscript: Type.Literal(false)
});
export const OcrAggregateV2Schema = object({
  schema_version: Type.Literal('ocr-aggregate-v2'), document: OcrDocumentIdentityV2Schema,
  context: OcrExecutionContextV2Schema,
  successful_pages: Type.Array(OcrCheckpointRefV2Schema, { maxItems: OCR_V2_LIMITS.document_pages }),
  coverage: OcrEngineResponseSchema.properties.coverage, eligible_for_manuscript: Type.Literal(false)
});
export type OcrDocumentIdentityV2 = Static<typeof OcrDocumentIdentityV2Schema>;
export type OcrPageIdentityV2 = Static<typeof OcrPageIdentityV2Schema>;
export type OcrPageResultV2 = Static<typeof OcrPageResultV2Schema>;
export type OcrPageCheckpointV2 = Static<typeof OcrPageCheckpointV2Schema>;
export type OcrCheckpointRefV2 = Static<typeof OcrCheckpointRefV2Schema>;
export type OcrExecutionContextV2 = Static<typeof OcrExecutionContextV2Schema>;
export type OcrBatchRequestV2 = Static<typeof OcrBatchRequestV2Schema>;
export type OcrBatchResponseV2 = Static<typeof OcrBatchResponseV2Schema>;
export type OcrAggregateV2 = Static<typeof OcrAggregateV2Schema>;
