import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDENTITY_PARSER_106, IDENTITY_PARSER_ROOT, IDENTITY_PARSER_TEST, verifyIdentityParserRecord } from './identity-parser-source.mjs';
import { REFERENCE_PROFILE_SHA256, QA_BASELINE_PROFILE_SHA256, verifyReferenceRecord, verifyReferenceRuns,
  verifyQaBaselineRecord, verifyQaBaselineRuns } from './browser-reference-source.mjs';

export const CAPABILITY_SCHEMA = 'pr-gate-capabilities-v1';
export const PARSER_106 = Object.freeze({
  commit: 'fb6c12c60b98d14103780da882f0d4da2303f191',
  tree: 'd4109eedad1c16f282170cd07ddd93030a723eb9',
  python_tree: 'cf2eb4ae549c6ff061c7a6a3d054627eb80e03c4',
  version: 'bondbuddy-document-parser-1.0.6',
  archive_sha256: '9ee74af7fe4d0e47b3a9574a3161bd9fc9e82f5ed8e3a887ec683e2d90dcb9f5',
});
export const CAPABILITY_PATHS = Object.freeze({ directory: '/evidence/capabilities', parser: '/opt/pr-gate-parser106', identityParser: IDENTITY_PARSER_ROOT, ca: '/evidence/capabilities/tls/ca.pem' });
export const DEVELOPMENT_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
export const HTTPS_BLOB = `DefaultEndpointsProtocol=https;AccountName=devstoreaccount1;AccountKey=${DEVELOPMENT_KEY};BlobEndpoint=https://127.0.0.1:10003/devstoreaccount1;`;
export const TEMPLATE_DATABASE = 'postgresql://bondbuddy:synthetic-ci-only@127.0.0.1:5432/bb_m4_core';
export const CAPABILITY_DATABASE = 'bb_pr_gate_target_period';
export const DEDICATED_DATABASE = TEMPLATE_DATABASE.replace('/bb_m4_core', '/' + CAPABILITY_DATABASE);

// Exact source paths only. These flags enable authorized local parsing or
// synthetic PostgreSQL/API fixtures, never live models, browser or desktop jobs.
const sampleFlags = {
  'apps/api/src/upload-capacity.test.ts': 'BB_RUN_UPLOAD_CAPACITY_TESTS',
  'apps/worker/src/authorized-qx-mixed-pdf-upload-parse.integration.test.ts': 'BB_RUN_AUTHORIZED_QX_UPLOAD_PARSE',
  'apps/worker/src/authorized-rq202506-upload-parse.integration.test.ts': 'BB_RUN_AUTHORIZED_RQ_UPLOAD_PARSE',
  'apps/worker/src/rule-source-date-json-guards.pg.integration.test.ts': 'BB_RUN_RULE_SOURCE_DATE_JSON_PG_TESTS',
  'apps/worker/src/target-period-candidates.authorized-qx202606.test.ts': 'BB_RUN_AUTHORIZED_QX202606_TARGET_PERIODS',
  'apps/worker/src/target-period-candidates.authorized-zq202312.test.ts': 'BB_RUN_AUTHORIZED_ZQ202312_TARGET_PERIOD_CANDIDATES',
  'apps/worker/src/authorized-qx-mixed-pdf-parser.integration.test.ts': 'BB_RUN_AUTHORIZED_QX_MIXED_PDF',
  'apps/worker/src/authorized-qx04-public-upload-parse.integration.test.ts': 'BB_RUN_AUTHORIZED_QX04_UPLOAD_PARSE',
  'apps/worker/src/authorized-rq202509-xlsx-upload-parse.integration.test.ts': 'BB_RUN_AUTHORIZED_RQ202509_XLSX_UPLOAD_PARSE',
  'apps/worker/src/authorized-sample-membership-loader.pg.integration.test.ts': 'BB_RUN_AUTHORIZED_SAMPLE_MEMBERSHIP_PG_TESTS',
  'apps/worker/src/authorized-sample-pg-e2e.test.ts': 'BB_RUN_AUTHORIZED_SAMPLE_PG_E2E',
  'apps/worker/src/parse-snapshot-audit.authorized-samples.integration.test.ts': 'BB_RUN_AUTHORIZED_PARSE_SNAPSHOT_AUDIT',
  'apps/worker/src/sse-private-test-rule-capability.pg.integration.test.ts': 'BB_RUN_SSE_PRIVATE_TEST_CAPABILITY_PG_TESTS',
  'apps/worker/src/target-period-candidates.authorized-rq202509.test.ts': 'BB_RUN_AUTHORIZED_RQ202509_TARGET_PERIOD_CANDIDATES',
};
const parserFiles = ['native-financial-fact-producer-authorized.test.ts', 'native-financial-fact-review-authorized.test.ts'];
export const FILE_CAPABILITIES = Object.freeze(Object.fromEntries([
  ['apps/api/src/direct-upload.pg.test.ts', { id: 'https-blob', env: { BB_TEST_AZURITE_CONNECTION_STRING: HTTPS_BLOB, NODE_EXTRA_CA_CERTS: CAPABILITY_PATHS.ca } }],
  [IDENTITY_PARSER_TEST, { id: 'identity-parser-106', env: { BB_PARSER_106_SOURCE_ROOT: CAPABILITY_PATHS.identityParser } }],
  ...parserFiles.map(file => [`apps/worker/src/${file}`, { id: 'parser-106', env: { BB_PARSER_106_SOURCE_ROOT: CAPABILITY_PATHS.parser } }]),
  ...Object.entries(sampleFlags).map(([file, flag]) => [file, { id: 'authorized-local-sample', env: { [flag]: '1' } }]),
  ['apps/worker/src/target-period-candidate-snapshot-repository.test.ts', { id: 'dedicated-pg', env: { TARGET_PERIOD_CANDIDATE_TEST_DATABASE_URL: DEDICATED_DATABASE } }],
].sort(([a], [b]) => a.localeCompare(b))));
export const capabilityHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const PROFILE_SHA256 = capabilityHash({ files: FILE_CAPABILITIES, identity_parser: IDENTITY_PARSER_106, reference_components: REFERENCE_PROFILE_SHA256, qa_single_start_baseline: QA_BASELINE_PROFILE_SHA256 });
export const MANAGED_ENV_KEYS = Object.freeze([...Object.values(sampleFlags), 'BB_PARSER_106_SOURCE_ROOT', 'TARGET_PERIOD_CANDIDATE_TEST_DATABASE_URL', 'NODE_EXTRA_CA_CERTS']);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function verifyPreparedCapabilities(prepared, expected, now = Date.now()) {
  assert.equal(prepared?.schema, CAPABILITY_SCHEMA, 'Capability preparation is missing');
  assert.equal(prepared.status, 'passed');
  for (const key of ['commit', 'tree']) assert.ok(oid(expected?.[key]) && prepared[key] === expected[key], `Capability ${key} differs from candidate`);
  assert.equal(prepared.profile_sha256, PROFILE_SHA256, 'Capability profile changed');
  verifyReferenceRecord(prepared.reference_components);
  verifyQaBaselineRecord(prepared.qa_single_start_baseline);
  assert.deepEqual(prepared.parser?.source, PARSER_106, 'Historical parser source changed');
  assert.equal(prepared.parser.archive_sha256, PARSER_106.archive_sha256, 'Historical parser archive changed');
  assert.equal(prepared.parser.root, CAPABILITY_PATHS.parser);
  verifyIdentityParserRecord(prepared.identity_parser);
  assert.ok(sha(prepared.tls?.ca_sha256) && sha(prepared.tls.server_sha256), 'Test TLS identity missing');
  assert.equal(prepared.tls.endpoint, 'https://127.0.0.1:10003/devstoreaccount1');
  assert.equal(prepared.tls.ca_path, CAPABILITY_PATHS.ca);
  const from = Date.parse(prepared.tls.valid_from), to = Date.parse(prepared.tls.valid_to);
  assert.ok(Number.isFinite(from) && Number.isFinite(to) && from <= now && now < to && to - from <= 25 * 3600000, 'Test TLS certificate is expired or not short lived');
  assert.equal(prepared.database.template, TEMPLATE_DATABASE);
  assert.equal(prepared.database.dedicated, DEDICATED_DATABASE);
  assert.ok(sha(prepared.authorized_manifest_sha256), 'Authorized sample manifest hash missing');
  return prepared;
}

export function capabilityEnvironment(testId, environment, prepared) {
  const env = { ...environment };
  // Never let one file's capability or caller-supplied opt-in leak to another.
  for (const key of MANAGED_ENV_KEYS) delete env[key];
  delete env.PR_GATE_CAPABILITIES_FILE;
  const profile = FILE_CAPABILITIES[testId];
  if (!prepared) return { env, record: null };
  assert.equal(env.BB_TEST_DATABASE_URL, TEMPLATE_DATABASE, 'Capability tests require the disposable loopback database');
  assert.equal(env.BB_TEST_AZURITE_CONNECTION_STRING, 'UseDevelopmentStorage=true', 'Capability base storage must be the disposable HTTP emulator');
  assert.notEqual(env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS certificate verification must remain enabled');
  for (const key of ['BB_TEST_LIVE_AUTHORING', 'BB_PLATFORM_PROBE_ENABLED', 'BB_REVIEW_WEB_SEARCH_ENABLED']) assert.equal(env[key], '0', 'Live model/probe/search must stay disabled');
  if (!profile) return { env, record: null };
  Object.assign(env, profile.env);
  return { env, record: { test_id: testId, profile_id: profile.id, profile_sha256: PROFILE_SHA256,
    preparation_sha256: capabilityHash(prepared), environment_keys: Object.keys(profile.env).sort() } };
}

export function verifyCapabilityRuns(receipt, expected, now = Date.now()) {
  // Completed evidence remains historical evidence after its disposable TLS
  // certificate expires. It had to be valid for the actual completed run.
  const prepared = verifyPreparedCapabilities(receipt.capabilities, expected, Date.parse(receipt.finished_at));
  if (expected.matrix?.some(row => row.groups === 'browser')) { verifyReferenceRuns(receipt, expected); verifyQaBaselineRuns(receipt, expected); }
  for (const shard of receipt.shards) {
    const service = shard.capability_preparation;
    assert.equal(service?.status, 'passed', 'Capability service readiness missing');
    assert.equal(service.preparation_sha256, capabilityHash(prepared));
    assert.equal(service.shard, shard.name); assert.equal(service.commit, expected.commit); assert.equal(service.tree, expected.tree);
    assert.ok(service.postgres_version >= 160000 && service.postgres_version < 170000);
    assert.equal(service.database, CAPABILITY_DATABASE); assert.equal(service.https_endpoint, prepared.tls.endpoint);
    assert.equal(service.blob_roundtrip_sha256, capabilityHash('synthetic-pr-gate-https-readiness'));
    assert.equal(service.cors_origin, 'https://bondbuddy.test');
    const completed = Date.parse(service.completed_at);
    assert.ok(Number.isFinite(completed) && completed >= Date.parse(prepared.tls.valid_from) && completed <= Date.parse(receipt.finished_at), 'Capability service readiness timestamp invalid');
  }
  const rows = receipt.shards.flatMap(shard => {
    assert.ok(Array.isArray(shard.summary?.capabilities), 'Per-file capability receipts missing');
    return shard.summary.capabilities;
  });
  assert.deepEqual(rows.map(row => row.test_id).sort(), Object.keys(FILE_CAPABILITIES).sort(), 'Capability files missing or duplicated');
  for (const row of rows) {
    const profile = FILE_CAPABILITIES[row.test_id];
    assert.equal(row.profile_id, profile.id); assert.equal(row.profile_sha256, PROFILE_SHA256);
    assert.equal(row.preparation_sha256, capabilityHash(prepared));
    assert.deepEqual(row.environment_keys, Object.keys(profile.env).sort());
    assert.equal(row.status, 'passed'); assert.ok(Number.isSafeInteger(row.tests) && row.tests > 0);
    assert.equal(row.skipped, 0, 'Required capability test skipped');
  }
}
