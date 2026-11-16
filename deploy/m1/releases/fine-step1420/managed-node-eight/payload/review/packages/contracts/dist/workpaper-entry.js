import { Type } from '@sinclair/typebox';
const obj = (p) => Type.Object(p, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128 });
export const WORKPAPER_LIMITS = { fileBytes: 10 * 1024 * 1024, items: 1000, rows: 10000, sheets: 30 };
export const WorkpaperEntrySchema = obj({ id, code: Type.String({ maxLength: 100 }), title: Type.String({ minLength: 1, maxLength: 300 }),
    folder: Type.String({ maxLength: 600 }), instructions: Type.String({ maxLength: 2000 }), sheet: Type.String({ maxLength: 200 }), row: Type.Integer({ minimum: 1 }),
    kind: Type.Union([Type.Literal('file'), Type.Literal('folder')]), path: Type.String({ minLength: 1, maxLength: 1000 }) });
export const WorkpaperDecisionSchema = obj({ item_id: id, status: Type.Union(['generate', 'not_applicable', 'missing_information', 'external_evidence'].map(s => Type.Literal(s))),
    reason: Type.String({ minLength: 1, maxLength: 3000 }), missing_materials: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    citations: Type.Array(obj({ span_id: id, location: Type.Optional(Type.String({ maxLength: 12000 })), quote: Type.String({ minLength: 1, maxLength: 2000 }) }), { maxItems: 10 }) });
export const WORKPAPER_DECISION_LABELS = { generate: '可生成底稿', not_applicable: '业务不适用', missing_information: '资料不足，暂无法生成', external_evidence: '需外部原始证据' };
export const WorkpaperTaskSchema = obj({ batch_id: id, catalogue_id: id, entry: WorkpaperEntrySchema, mode: Type.Optional(Type.Literal('direct')), execution: Type.Optional(Type.Union([Type.Literal('shared_batch_v1'), Type.Literal('progressive_item_v1'), Type.Literal('grouped_batch_v1')])), decision: Type.Optional(WorkpaperDecisionSchema) });
