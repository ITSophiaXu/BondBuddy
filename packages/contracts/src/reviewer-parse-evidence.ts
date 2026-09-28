import { Type } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128 });
const sha256 = Type.String({ pattern: '^[a-f0-9]{64}$' });
const locator = Type.Record(Type.String(), Type.Unknown());

export const reviewerParseEvidenceSchemas = {
  ReviewerParseEvidenceResponse: Type.Object({
    project_id: id,
    material_id: id,
    material_version: Type.Integer({ minimum: 1 }),
    material_sha256: sha256,
    snapshot_id: id,
    parser_version: Type.String({ minLength: 1, maxLength: 128 }),
    response_sha256: sha256,
    response_status: Type.Union([Type.Literal('parsed'), Type.Literal('needs_confirmation')]),
    warning_codes: Type.Array(Type.String({ minLength: 1, maxLength: 128 })),
    items: Type.Array(Type.Object({
      record_id: id,
      record_sha256: sha256,
      content_sha256: sha256,
      locator_type: Type.Union([Type.Literal('docx_block'), Type.Literal('pdf_bbox'), Type.Literal('xlsx_cell'),
        Type.Literal('csv_cell'), Type.Literal('text_line')]),
      locator,
      literal_quote: Type.String({ minLength: 1, maxLength: 65536 }),
      uncertainty: Type.Array(Type.Unknown()),
    }, { additionalProperties: false })),
    next_cursor: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
  }, { additionalProperties: false }),
} as const;
