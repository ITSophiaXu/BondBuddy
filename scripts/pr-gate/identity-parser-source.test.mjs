import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { IDENTITY_PARSER_106, IDENTITY_PARSER_ROOT, IDENTITY_PARSER_TEST,
  verifyIdentityParserArchive, verifyIdentityParserRecord, restoreIdentityParserArchive } from './identity-parser-source.mjs';
import { CAPABILITY_PATHS, PARSER_106, TEMPLATE_DATABASE, capabilityEnvironment, verifyPreparedCapabilities } from './capabilities.mjs';
import { syntheticCapabilities } from './capabilities.test-fixture.mjs';
const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, now = Date.parse('2026-11-11T13:01:00Z');
const environment = { BB_TEST_DATABASE_URL: TEMPLATE_DATABASE, BB_TEST_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
  BB_TEST_LIVE_AUTHORING: '0', BB_PLATFORM_PROBE_ENABLED: '0', BB_REVIEW_WEB_SEARCH_ENABLED: '0' };

test('only the issuer identity file uses its original optimized 1.0.6 source; both XLSX bridges keep #196', () => {
  const prepared = syntheticCapabilities(candidate);
  const identity = capabilityEnvironment(IDENTITY_PARSER_TEST, environment, prepared);
  assert.equal(identity.env.BB_PARSER_106_SOURCE_ROOT, IDENTITY_PARSER_ROOT);
  assert.equal(identity.record.profile_id, 'identity-parser-106');
  for (const file of ['native-financial-fact-producer-authorized.test.ts', 'native-financial-fact-review-authorized.test.ts']) {
    const result = capabilityEnvironment('apps/worker/src/' + file, environment, prepared);
    assert.equal(result.env.BB_PARSER_106_SOURCE_ROOT, CAPABILITY_PATHS.parser);
    assert.equal(result.record.profile_id, 'parser-106');
  }
  const unrelated = capabilityEnvironment('apps/worker/src/other.test.ts', { ...environment, BB_PARSER_106_SOURCE_ROOT: IDENTITY_PARSER_ROOT }, prepared);
  assert.equal(unrelated.env.BB_PARSER_106_SOURCE_ROOT, undefined); assert.equal(unrelated.record, null);
});

test('identity parser preparation rejects omitted, old, current, modified or path-substituted source evidence', () => {
  assert.doesNotThrow(() => verifyPreparedCapabilities(syntheticCapabilities(candidate), candidate, now));
  for (const change of [p => delete p.identity_parser, p => p.identity_parser = p.parser,
    p => p.identity_parser.source = { ...PARSER_106 }, p => p.identity_parser.source = { ...IDENTITY_PARSER_106, version: 'bondbuddy-document-parser-1.0.8' },
    p => p.identity_parser.source = { ...IDENTITY_PARSER_106, commit: candidate.commit },
    p => p.identity_parser.archive_sha256 = PARSER_106.archive_sha256, p => p.identity_parser.parser_sha256 = 'f'.repeat(64),
    p => p.identity_parser.root = CAPABILITY_PATHS.parser]) {
    const prepared = structuredClone(syntheticCapabilities(candidate)); change(prepared);
    assert.throws(() => verifyPreparedCapabilities(prepared, candidate, now));
  }
  assert.doesNotThrow(() => verifyIdentityParserRecord(syntheticCapabilities(candidate).identity_parser));
});

test('identity parser extraction rejects untrusted archive bytes before creating a destination', () => {
  assert.throws(() => verifyIdentityParserArchive(Buffer.from('synthetic tampered archive')), /hash mismatch/);
  assert.throws(() => restoreIdentityParserArchive(fileURLToPath(import.meta.url), '/must-not-be-created'), /hash mismatch/);
});
