import { Type, type Static } from '@sinclair/typebox';

// #6 data lifecycle. The web renders retention/deletion copy only from DataPolicyResponse, and the API
// derives it from the same server config the purge jobs read, so copy and behaviour cannot drift.
export const DATA_POLICY_VERSION = 'data_policy_m1_v1' as const;
// Outbox events written by project deletion and the deleted-content purge job.
export const DATA_LIFECYCLE_EVENTS = ['project.deleted', 'material.derived_content_purged', 'project.content_purged'] as const;
// What the purge removes vs. what stays for audit and cost reconciliation.
export const DELETION_PURGED_CONTENT = ['material_bytes', 'parse_evidence_text', 'ocr_objects', 'parse_cache_objects', 'word_artifacts', 'prompt_snapshots', 'provider_results'] as const;
export const DELETION_RETAINED_METADATA = ['hashes_and_sizes', 'run_and_job_states', 'model_call_attempts_and_usage', 'audit_and_purge_receipts'] as const;

const obj = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const days = Type.Integer({ minimum: 0, maximum: 3650 });
const nullable = <T extends ReturnType<typeof Type.Integer>>(schema: T) => Type.Union([schema, Type.Null()]);
const enumArray = <T extends readonly string[]>(values: T) => Type.Array(Type.Union(values.map(value => Type.Literal<T[number]>(value))), { uniqueItems: true });

export const dataLifecycleSchemas = {
  DataPolicyResponse: obj({
    policy_version: Type.Literal(DATA_POLICY_VERSION),
    storage_location: Type.Literal('platform_private_cloud', { description: 'Uploaded materials are copied to account-isolated private platform storage; the browser copy is not the only one.' }),
    server_side_processing: Type.Literal(true),
    model_provider_processing: Type.Literal(true, { description: 'Necessary content is sent from the server to the configured model provider to run requested tasks.' }),
    active_retention: Type.Literal('until_user_deletes', { description: 'Materials and results stay until the user deletes the material, the project or the account.' }),
    purge_enabled: Type.Boolean({ description: 'False means the purge job is not configured; the null windows below are then unknown, not zero.' }),
    deleted_content_purge_days: nullable(days),
    orphan_upload_purge_hours: nullable(Type.Integer({ minimum: 0, maximum: 87600 })),
    log_content_retention_days: Type.Integer({ minimum: 1, maximum: 3650 }),
    backup_retention_days: nullable(days),
    pinned_by_active_run: Type.Literal('retained_until_run_ends', { description: 'A deleted material still read by a non-terminal run in a live project is purged after that run ends.' }),
    purged_content: enumArray(DELETION_PURGED_CONTENT),
    retained_metadata: enumArray(DELETION_RETAINED_METADATA)
  })
} as const;
export type DataPolicy = Static<typeof dataLifecycleSchemas.DataPolicyResponse>;
