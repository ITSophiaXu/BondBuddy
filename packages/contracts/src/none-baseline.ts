import { Type, type Static } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128 });
export const HistoricalExclusionPinSchema = Type.Object({
  material_id: id, material_version: Type.Integer({ minimum: 1 }),
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' })
}, { additionalProperties: false });
export type HistoricalExclusionPin = Static<typeof HistoricalExclusionPinSchema>;
export const FIRST_DRAFT_EXCLUSION_SCOPE = 'project_undeleted_historical_versions' as const;
/** A distinct user action; target_confirmation and draft flags do not express this decision. */
export const FirstDraftConfirmationRequestSchema = Type.Object({
  decision: Type.Literal('generate_first_draft'),
  scope: Type.Literal(FIRST_DRAFT_EXCLUSION_SCOPE),
  excluded_historical: Type.Array(HistoricalExclusionPinSchema)
}, { additionalProperties: false });
export type FirstDraftConfirmationRequest = Static<typeof FirstDraftConfirmationRequestSchema>;
const time = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
export const NoneBaselineSnapshotSchema = Type.Object({
  version: Type.Literal('none-baseline-v1'), owner_user_id: id, project_id: id,
  project_kind: Type.Union([Type.Literal('update'), Type.Literal('generation')]),
  checked_at: time, excluded_historical: Type.Array(HistoricalExclusionPinSchema),
  first_draft_confirmation: Type.Union([Type.Null(), Type.Object({
    ...FirstDraftConfirmationRequestSchema.properties, confirmed_by: id, confirmed_at: time
  }, { additionalProperties: false })])
}, { additionalProperties: false });
export type NoneBaselineSnapshot = Static<typeof NoneBaselineSnapshotSchema>;
export const FirstDraftExclusionsResponseSchema = Type.Object({
  project_id: id, draft_revision: Type.Integer({ minimum: 1 }),
  project_kind: Type.Union([Type.Literal('update'), Type.Literal('generation')]),
  scope: Type.Literal(FIRST_DRAFT_EXCLUSION_SCOPE),
  excluded_historical: Type.Array(Type.Object({ ...HistoricalExclusionPinSchema.properties, filename: Type.String() }, { additionalProperties: false }))
}, { additionalProperties: false });
export type FirstDraftExclusionsResponse = Static<typeof FirstDraftExclusionsResponseSchema>;
