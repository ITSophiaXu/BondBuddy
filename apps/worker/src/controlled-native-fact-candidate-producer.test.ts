import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SemanticFactExtractionRequest } from './fact-candidate-producer.js';
import {
  createControlledNativeFactCandidateProducer,
  createTrustedNativeParseCompletionResolver,
} from './controlled-native-fact-candidate-producer.js';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import { createNativeFinancialFactExtractor } from './native-financial-fact-extractor.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function request(overrides: Partial<SemanticFactExtractionRequest> = {}): SemanticFactExtractionRequest {
  return {
    schema_version: 'semantic-fact-extraction-request-v1', owner_user_id: 'owner-1', project_id: 'project-1',
    input_revision: 1, input_hash: digest('input'), issuer_identity_record_id: 'identity-1',
    issuer_identity_version: 1, issuer_identity_hash: digest('identity'), entity_id: 'issuer-1',
    material_id: 'material-1', material_version: 2, material_sha256: digest('material'),
    parse_snapshot_id: 'snapshot-1', parse_response_sha256: digest('response'),
    parser_version: 'bondbuddy-document-parser-1.0.6', records: [
      { record_id: 'evidence-1', material_id: 'material-1', material_version: 2, content_hash: digest('material'),
        locator_type: 'xlsx_cell', locator: { sheet: 'Other', cell: 'A1' }, literal_quote: 'synthetic', context: '',
        extraction_method: 'native_text', extractor_version: 'synthetic-parser', confidence: 1,
        uncertainty: [], formatting: { sheet_state: 'visible' } },
    ],
    ...overrides,
  };
}

function snapshot(req: SemanticFactExtractionRequest, overrides: Partial<StoredParseSnapshot> = {}): StoredParseSnapshot {
  return {
    snapshotId: req.parse_snapshot_id, ownerUserId: req.owner_user_id, projectId: req.project_id,
    materialId: req.material_id, materialVersion: req.material_version, contentSha256: req.material_sha256,
    parserVersion: req.parser_version, requestId: 'synthetic-request', requestHash: digest('request'),
    requestOptions: {}, responseSha256: req.parse_response_sha256,
    response: {
      schema_version: 'document-parse-response-v1', request_id: 'synthetic-request', parser_version: req.parser_version,
      status: 'parsed', material: { material_id: req.material_id, material_version: req.material_version,
        media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: req.material_sha256 },
      records: [], warnings: [], document: { page_count: null }, error: null,
    },
    evidence: [], createdAt: '2026-09-26T00:00:00.000Z', replayed: false,
    ...overrides,
  };
}

const syntheticPool = {} as never;

test('trusted resolver reads by the exact owner/project/material/version/snapshot pin', async () => {
  const req = request();
  const saved = snapshot(req);
  let actual: unknown[] = [];
  const resolver = createTrustedNativeParseCompletionResolver(syntheticPool, async (_dependencies, context, id) => {
    actual = [context, id];
    return saved;
  });

  assert.deepEqual(await resolver(req), { status: 'parsed', warnings: [] });
  assert.deepEqual(actual, [{ ownerUserId: 'owner-1', projectId: 'project-1', materialId: 'material-1', materialVersion: 2 }, 'snapshot-1']);
});

test('missing, tampered, cross-owner and failed snapshots fail closed', async () => {
  const req = request();
  const missing = createTrustedNativeParseCompletionResolver(syntheticPool, async () => null);
  await assert.rejects(missing(req), /FACT_EXTRACTION_PARSE_SNAPSHOT_MISSING/);

  for (const altered of [
    snapshot(req, { responseSha256: digest('tampered response') }),
    snapshot(req, { ownerUserId: 'other-owner' }),
    snapshot(req, { materialVersion: 3 }),
  ]) {
    const mismatched = createTrustedNativeParseCompletionResolver(syntheticPool, async () => altered);
    await assert.rejects(mismatched(req), /FACT_EXTRACTION_PARSE_SNAPSHOT_MISMATCH/);
  }

  const failedResponse = { ...snapshot(req).response, status: 'failed' as const,
    error: { code: 'SYNTHETIC_FAILURE', message: 'synthetic parser failure' } };
  const failed = createTrustedNativeParseCompletionResolver(syntheticPool, async () => snapshot(req, { response: failedResponse }));
  await assert.rejects(failed(req), /FACT_EXTRACTION_PARSE_SNAPSHOT_FAILED/);
});

test('unsupported parser and uncertain parse produce needs_review without facts', async () => {
  const unsupportedRequest = request({ parser_version: 'bondbuddy-document-parser-9.9.9' });
  const unsupportedResolver = createTrustedNativeParseCompletionResolver(syntheticPool,
    async () => snapshot(unsupportedRequest));
  const unsupported = await createNativeFinancialFactExtractor(unsupportedResolver).extract(unsupportedRequest);
  assert.equal(unsupported.facts.length, 0);
  assert.equal(unsupported.needs_review[0]?.reason_code, 'UNSUPPORTED_NATIVE_FINANCIAL_PARSE');

  const uncertainRequest = request();
  const uncertainResponse = { ...snapshot(uncertainRequest).response, status: 'needs_confirmation' as const,
    warnings: [{ code: 'NEEDS_CONFIRMATION', message: 'synthetic parse uncertainty' }] };
  const uncertainResolver = createTrustedNativeParseCompletionResolver(syntheticPool,
    async () => snapshot(uncertainRequest, { response: uncertainResponse }));
  const uncertain = await createNativeFinancialFactExtractor(uncertainResolver).extract(uncertainRequest);
  assert.equal(uncertain.facts.length, 0);
  assert.equal(uncertain.needs_review[0]?.reason_code, 'PARSER_STATUS_OR_WARNING_NEEDS_CONFIRMATION');
});

test('controlled factory is an uninstalled producer function over the existing persistence path', () => {
  const producer = createControlledNativeFactCandidateProducer({ pool: syntheticPool });
  assert.equal(typeof producer, 'function');
});
