import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CAPABILITY_PATHS, FILE_CAPABILITIES, HTTPS_BLOB, MANAGED_ENV_KEYS, PARSER_106, TEMPLATE_DATABASE, capabilityEnvironment, verifyPreparedCapabilities, verifyCapabilityRuns } from './capabilities.mjs';
import { verifyParserArchive, restoreParserArchive } from './parser-source.mjs';
import { inspectTestCertificates } from './capability-runtime.mjs';
import { syntheticCapabilities, syntheticCapabilityRuns, syntheticCapabilityService } from './capabilities.test-fixture.mjs';
const expected = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, now = Date.parse('2026-11-11T13:01:00Z');
const baseEnv = () => ({ BB_TEST_DATABASE_URL: TEMPLATE_DATABASE, BB_TEST_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true', BB_TEST_LIVE_AUTHORING: '0', BB_PLATFORM_PROBE_ENABLED: '0', BB_REVIEW_WEB_SEARCH_ENABLED: '0', PATH: 'synthetic-system-path' });
const receipt = () => {
  const capabilities = syntheticCapabilities(expected);
  return { capabilities, finished_at: new Date(now).toISOString(), shards: [{ name: 'synthetic', capability_preparation: syntheticCapabilityService(capabilities, 'synthetic'), summary: { capabilities: syntheticCapabilityRuns(capabilities, '') } }] };
};
test('all nineteen capability paths are exact existing tests with narrowly named opt-ins', () => {
  assert.equal(Object.keys(FILE_CAPABILITIES).length, 19);
  for (const [id, profile] of Object.entries(FILE_CAPABILITIES)) {
    assert.ok(!/[\\*]/.test(id) && !id.includes('..'));
    assert.ok(existsSync(fileURLToPath(new URL('../../' + id, import.meta.url))), id);
    assert.ok(!Object.keys(profile.env).some(key => /BB_E2E|LIVE_AUTHORING|PLATFORM_PROBE|WEB_SEARCH|DESKTOP/.test(key)));
  }
});
test('HTTPS capability changes only direct-upload and never disables TLS verification', () => {
  const prepared = syntheticCapabilities(expected), original = baseEnv();
  const direct = capabilityEnvironment('apps/api/src/direct-upload.pg.test.ts', original, prepared);
  assert.equal(direct.env.BB_TEST_AZURITE_CONNECTION_STRING, HTTPS_BLOB);
  assert.equal(direct.env.NODE_EXTRA_CA_CERTS, CAPABILITY_PATHS.ca);
  assert.equal(direct.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  for (const id of ['apps/api/src/other.test.ts', 'apps/api/src/nested/direct-upload.pg.test.ts', '../apps/api/src/direct-upload.pg.test.ts']) {
    const result = capabilityEnvironment(id, original, prepared); assert.equal(result.record, null);
    assert.equal(result.env.BB_TEST_AZURITE_CONNECTION_STRING, 'UseDevelopmentStorage=true'); assert.equal(result.env.NODE_EXTRA_CA_CERTS, undefined);
  }
  assert.deepEqual(original, baseEnv());
});
test('managed ambient opt-ins and parser/DB paths cannot leak to unrelated files', () => {
  const env = { ...baseEnv(), ...Object.fromEntries(MANAGED_ENV_KEYS.map(key => [key, 'unsafe-ambient'])), PR_GATE_CAPABILITIES_FILE: '/stale' };
  for (const prepared of [null, syntheticCapabilities(expected)]) {
    const result = capabilityEnvironment('apps/worker/src/unrelated.test.ts', env, prepared);
    assert.ok(MANAGED_ENV_KEYS.every(key => result.env[key] === undefined)); assert.equal(result.env.PR_GATE_CAPABILITIES_FILE, undefined);
  }
  const parser = capabilityEnvironment('apps/worker/src/native-financial-fact-producer-authorized.test.ts', env, syntheticCapabilities(expected));
  assert.equal(parser.env.BB_PARSER_106_SOURCE_ROOT, CAPABILITY_PATHS.parser);
  assert.equal(parser.env.TARGET_PERIOD_CANDIDATE_TEST_DATABASE_URL, undefined);
});
test('remote/production services and enabled live model/probe/search fail before file launch', () => {
  for (const patch of [{ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { BB_TEST_DATABASE_URL: TEMPLATE_DATABASE.replace('127.0.0.1', 'production.example') }, { BB_TEST_DATABASE_URL: TEMPLATE_DATABASE.replace('bb_m4_core', 'production') }, { BB_TEST_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=false' }, ...['BB_TEST_LIVE_AUTHORING', 'BB_PLATFORM_PROBE_ENABLED', 'BB_REVIEW_WEB_SEARCH_ENABLED'].map(key => ({ [key]: '1' }))]) {
    assert.throws(() => capabilityEnvironment('apps/api/src/direct-upload.pg.test.ts', { ...baseEnv(), ...patch }, syntheticCapabilities(expected)));
  }
});
test('prepared evidence requires the same candidate, historical source, fixed archive and local TLS identity', () => {
  verifyPreparedCapabilities(syntheticCapabilities(expected), expected, now);
  for (const mutate of [p => p.commit = 'c'.repeat(40), p => p.tree = 'd'.repeat(40), p => p.status = 'failed', p => p.profile_sha256 = 'f'.repeat(64), p => p.parser.archive_sha256 = 'f'.repeat(64), p => p.parser.source = { ...PARSER_106, version: '1.0.8' }, p => p.parser.root = '/workspace/python', p => p.tls.endpoint = 'http://127.0.0.1:10003', p => p.tls.ca_path = '/etc/ssl/certs', p => p.tls.valid_to = '2026-11-10T00:00:00Z', p => p.tls.valid_to = '2027-01-01T00:00:00Z', p => p.database.dedicated = TEMPLATE_DATABASE, p => delete p.authorized_manifest_sha256]) {
    const prepared = structuredClone(syntheticCapabilities(expected)); mutate(prepared); assert.throws(() => verifyPreparedCapabilities(prepared, expected, now));
  }
});
test('all exact capability files and real service preparation are required; skipped, omitted or borrowed records fail', () => {
  verifyCapabilityRuns(receipt(), expected, now);
  for (const mutate of [r => r.shards[0].summary.capabilities.pop(), r => r.shards[0].summary.capabilities.push(r.shards[0].summary.capabilities[0]), r => r.shards[0].summary.capabilities[0].skipped = 1, r => r.shards[0].summary.capabilities[0].tests = 0, r => r.shards[0].summary.capabilities[0].status = 'failed', r => r.shards[0].summary.capabilities[0].preparation_sha256 = 'f'.repeat(64), r => delete r.shards[0].capability_preparation, r => r.shards[0].capability_preparation.postgres_version = 150000, r => r.shards[0].capability_preparation.blob_roundtrip_sha256 = 'f'.repeat(64), r => r.shards[0].capability_preparation.cors_origin = '*']) {
    const value = receipt(); mutate(value); assert.throws(() => verifyCapabilityRuns(value, expected, now));
  }
});
test('completed historical receipt survives later certificate expiry; the actual run must fit certificate lifetime', () => {
  verifyCapabilityRuns(receipt(), expected, now + 365 * 86400000);
  const value = receipt(); value.finished_at = '2027-01-01T00:00:00Z'; assert.throws(() => verifyCapabilityRuns(value, expected, now));
});
test('untrusted parser bytes and invalid certificates are rejected before extraction or service access', () => {
  assert.throws(() => verifyParserArchive(Buffer.from('synthetic tampered archive')), /hash mismatch/);
  assert.throws(() => restoreParserArchive(fileURLToPath(import.meta.url), '/must-not-be-created'), /hash mismatch/);
  assert.throws(() => inspectTestCertificates('invalid', 'invalid', 'invalid', now));
});
test('real runner gives each synthetic child only its exact capability and records actual results', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bb-capability-child-'));
  try {
    for (const folder of ['apps/api/src', 'apps/api/dist']) mkdirSync(join(directory, folder), { recursive: true });
    writeFileSync(join(directory, 'exclusions.json'), JSON.stringify({ notInCi: [], knownFailing: [], allowSkip: [] }));
    const prepared = syntheticCapabilities(expected, Date.now());
    writeFileSync(join(directory, 'prepared.json'), JSON.stringify(prepared));
    const write = (name, body) => {
      writeFileSync(join(directory, 'apps/api/src/' + name + '.test.ts'), '// synthetic test source');
      writeFileSync(join(directory, 'apps/api/dist/' + name + '.test.js'), `import test from 'node:test';import assert from 'node:assert/strict';test('synthetic child environment only',()=>{${body}});`);
    };
    write('direct-upload.pg', `assert.equal(process.env.NODE_EXTRA_CA_CERTS,${JSON.stringify(CAPABILITY_PATHS.ca)});assert.equal(process.env.BB_TEST_AZURITE_CONNECTION_STRING,${JSON.stringify(HTTPS_BLOB)});assert.equal(process.env.BB_RUN_UPLOAD_CAPACITY_TESTS,undefined);`);
    write('unrelated', "assert.equal(process.env.NODE_EXTRA_CA_CERTS,undefined);assert.equal(process.env.BB_TEST_AZURITE_CONNECTION_STRING,'UseDevelopmentStorage=true');assert.equal(process.env.BB_RUN_UPLOAD_CAPACITY_TESTS,undefined);");
    const env = { ...process.env, ...baseEnv(), GITHUB_SHA: expected.commit, PR_GATE_TREE: expected.tree, PR_GATE_CAPABILITIES_FILE: join(directory, 'prepared.json'), BB_RUN_UPLOAD_CAPACITY_TESTS: 'ambient-must-not-leak' };
    delete env.NODE_TEST_CONTEXT; delete env.GITHUB_STEP_SUMMARY;
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), 'run', '--root', directory, '--group', 'api', '--name', 'synthetic', '--exclusions', join(directory, 'exclusions.json'), '--out', join(directory, 'out')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const summary = JSON.parse(readFileSync(join(directory, 'out/summary-synthetic.json'), 'utf8'));
    assert.equal(summary.counts.selected, 2); assert.equal(summary.counts.passed, 2); assert.equal(summary.capabilities.length, 1);
    assert.deepEqual(summary.capabilities[0], { ...syntheticCapabilityRuns(prepared, 'apps/api/src/direct-upload.pg.test.ts')[0] });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
