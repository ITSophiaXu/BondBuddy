import {Type, type Static} from '@sinclair/typebox';

// Curated metadata only. Customer content, auth material and raw stdout never enter this DTO.
const scalar=Type.Union([Type.String({maxLength:12000}),Type.Number(),Type.Boolean(),Type.Null()]);
const row=Type.Record(Type.String({pattern:'^[a-z][a-z0-9_]{0,63}$'}),scalar);
const table=Type.Object({name:Type.String(),available:Type.Boolean(),total:Type.Integer({minimum:0}),truncated:Type.Boolean(),rows:Type.Array(row)}, {additionalProperties:false});
export const AdminInspectionSnapshotSchema=Type.Object({
  schema_version:Type.Literal(1),captured_at:Type.String(),source:Type.Union([Type.Literal('live_database'),Type.Literal('production_snapshot'),Type.Literal('historical_evidence'),Type.Literal('synthetic_test')]),
  release:Type.Union([Type.String(),Type.Null()]),scope:Type.Object({run_limit:Type.Integer(),run_count:Type.Integer(),available_run_count:Type.Integer(),description:Type.String()},{additionalProperties:false}),
  tables:Type.Array(table),warnings:Type.Array(Type.String())
},{additionalProperties:false});
export type AdminInspectionSnapshot=Static<typeof AdminInspectionSnapshotSchema>;
export type AdminInspectionRow=Static<typeof row>;
export const AdminInspectionAccessSchema=Type.Object({allowed:Type.Boolean()},{additionalProperties:false});
export const adminInspectionSchemas={AdminInspectionSnapshotResponse:AdminInspectionSnapshotSchema,AdminInspectionAccessResponse:AdminInspectionAccessSchema};
