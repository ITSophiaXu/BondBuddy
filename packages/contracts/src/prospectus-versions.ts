import { Type, type Static } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128 });
const integer = Type.Integer({ minimum: 1 });
const nullable = <T extends import('@sinclair/typebox').TSchema>(s: T) => Type.Union([s, Type.Null()]);
const obj = <T extends import('@sinclair/typebox').TProperties>(p: T) => Type.Object(p, { additionalProperties: false });
export const ProspectusVersionSchema = obj({
  version_id: id, sequence: integer, origin: Type.Union([Type.Literal('upload'), Type.Literal('generated')]),
  filename: Type.String(), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), created_at: Type.String({ format: 'date-time' }),
  material_id: nullable(id), material_version: nullable(integer), artifact_id: nullable(id), artifact_version: nullable(integer),
  revision_artifact_id: nullable(id), run_id: nullable(id),
  delete_block_reason: Type.Optional(nullable(Type.Union([Type.Literal('current'), Type.Literal('used'), Type.Literal('generated')]))),
});
export const prospectusVersionSchemas = {
  UpdateWorkspaceRequest: obj({}),
  UpdateWorkspaceResponse: obj({ source_project_id: id, update_project_id: id }),
  ProspectusVersionsResponse: obj({ project_id: id, current_version_id: nullable(id), selection_revision: Type.Integer({ minimum: 0 }), inactive_material_ids: Type.Array(id), versions: Type.Array(ProspectusVersionSchema) }),
  ProspectusVersionSaveRequest: obj({ request_id: id, expected_selection_revision: Type.Integer({ minimum: 0 }), material_id: id, material_version: integer, sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) }),
  ProspectusVersionSelectRequest: obj({ request_id: id, expected_selection_revision: Type.Integer({ minimum: 0 }), version_id: id }),
};
export type ProspectusVersion = Static<typeof ProspectusVersionSchema>;
export type ProspectusVersions = Static<typeof prospectusVersionSchemas.ProspectusVersionsResponse>;
