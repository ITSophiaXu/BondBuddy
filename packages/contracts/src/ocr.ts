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
