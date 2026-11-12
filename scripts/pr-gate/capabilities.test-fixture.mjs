// Synthetic evidence for validator unit tests only; never saved as a gate pass.
import { CAPABILITY_SCHEMA, CAPABILITY_PATHS, PARSER_106, PROFILE_SHA256, TEMPLATE_DATABASE, DEDICATED_DATABASE, CAPABILITY_DATABASE, FILE_CAPABILITIES, capabilityHash } from './capabilities.mjs';
import { syntheticReferenceIdentity, syntheticQaBaselineIdentity } from './browser-reference.test-fixture.mjs';
export function syntheticCapabilities(expected, time = Date.parse('2026-11-11T13:00:00.000Z')) {
  return { schema: CAPABILITY_SCHEMA, status: 'passed', commit: expected.commit, tree: expected.tree, profile_sha256: PROFILE_SHA256,
    reference_components: syntheticReferenceIdentity(),
    qa_single_start_baseline: syntheticQaBaselineIdentity(),
    parser: { source: PARSER_106, archive_sha256: PARSER_106.archive_sha256, root: CAPABILITY_PATHS.parser },
    tls: { ca_sha256: '1'.repeat(64), server_sha256: '2'.repeat(64), valid_from: new Date(time - 1000).toISOString(), valid_to: new Date(time + 86400000).toISOString(), ca_path: CAPABILITY_PATHS.ca, endpoint: 'https://127.0.0.1:10003/devstoreaccount1' },
    database: { template: TEMPLATE_DATABASE, dedicated: DEDICATED_DATABASE }, authorized_manifest_sha256: '3'.repeat(64) };
}
export function syntheticCapabilityService(prepared, shard) {
  return { status: 'passed', shard, commit: prepared.commit, tree: prepared.tree, preparation_sha256: capabilityHash(prepared), postgres_version: 160010, database: CAPABILITY_DATABASE,
    https_endpoint: prepared.tls.endpoint, blob_roundtrip_sha256: capabilityHash('synthetic-pr-gate-https-readiness'), cors_origin: 'https://bondbuddy.test', completed_at: new Date(Date.parse(prepared.tls.valid_from) + 2000).toISOString() };
}
export function syntheticCapabilityRuns(prepared, prefix) {
  return Object.entries(FILE_CAPABILITIES).filter(([id]) => id.startsWith(prefix)).map(([id, profile]) => ({ test_id: id, profile_id: profile.id, profile_sha256: PROFILE_SHA256,
    preparation_sha256: capabilityHash(prepared), environment_keys: Object.keys(profile.env).sort(), status: 'passed', tests: 1, skipped: 0 }));
}
