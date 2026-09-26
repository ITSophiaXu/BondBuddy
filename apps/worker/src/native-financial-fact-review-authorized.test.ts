import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { SemanticFactExtractionRequest } from './fact-candidate-producer.js';
import { createNativeFinancialFactExtractor } from './native-financial-fact-extractor.js';
import { runDocumentParser, type DocumentParseRequest } from './document-parser.js';

const sourceRoot = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../../..'));
const manifestPath = join(sourceRoot, 'tests/samples/2026-09-25/manifest.json');
const parserPython = process.env.BB_PYTHON?.trim() || 'python3';
const parser106Root = process.env.BB_PARSER_106_SOURCE_ROOT?.trim();
const runAuthorized = process.env.BB_RUN_AUTHORIZED_LARGE_XLSX === '1';

if (runAuthorized && !parser106Root) {
  throw new Error('BB_RUN_AUTHORIZED_LARGE_XLSX=1 requires BB_PARSER_106_SOURCE_ROOT pointing to the #196 parser 1.0.6 source tree');
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

type AuthorizedFile = { file_id: string; path: string; bytes: number; sha256: string; media_type: string };
type AuthorizedManifest = { cases: Array<{ files: AuthorizedFile[] }> };

test('authorized large rq XLSX with cached formula values yields only bounded needs_review candidates', {
  skip: !runAuthorized ? 'set BB_RUN_AUTHORIZED_LARGE_XLSX=1 and BB_PARSER_106_SOURCE_ROOT to run the authorized review-only check' : false,
}, async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuthorizedManifest;
  const file = manifest.cases.flatMap((item) => item.files).find((item) => item.file_id === 'rq-202509-02');
  assert.ok(file, 'manifest must identify the authorized large rq-202509 XLSX');
  assert.equal(file.media_type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const filePath = resolve(sourceRoot, 'tests/samples/2026-09-25', file.path);
  const bytes = await readFile(filePath);
  assert.equal(bytes.byteLength, file.bytes, 'authorized sample byte count must match its manifest');
  const contentHash = sha(bytes);
  assert.equal(contentHash, file.sha256, 'authorized sample SHA-256 must match its manifest');

  const parseRequest: DocumentParseRequest = {
    schema_version: 'document-parse-request-v1',
    request_id: 'authorized-rq-202509-review-only',
    material: {
      material_id: file.file_id,
      material_version: 1,
      media_type: file.media_type as DocumentParseRequest['material']['media_type'],
      sha256: contentHash,
      authorized_local_path: filePath,
    },
    options: {},
  };
  let outputBytes = 0;
  const parsed = await runDocumentParser(parseRequest, {
    maxOutputBytes: 32 * 1024 * 1024,
    invoke: async (serialized, options) => {
      const python = spawnSync(parserPython, ['-m', 'bondbuddy_document_parser'], {
        cwd: parser106Root!,
        env: { ...process.env, PYTHONPATH: join(parser106Root!, 'python') },
        input: serialized,
        encoding: 'utf8',
        maxBuffer: options.maxOutputBytes,
        timeout: options.timeoutMs,
      });
      assert.equal(python.status, 0, `Python 1.0.6 parser failed: ${python.stderr}`);
      assert.ifError(python.error);
      outputBytes = Buffer.byteLength(python.stdout);
      return python.stdout;
    },
  });

  assert.equal(parsed.parser_version, 'bondbuddy-document-parser-1.0.6');
  assert.equal(parsed.status, 'needs_confirmation');
  assert.equal(parsed.records.length, 22014);
  assert.equal(parsed.document.cached_formula_results, 3821);
  assert.equal(parsed.records.filter((record) => record.uncertainty.includes('formula_cached_result_unverified')).length, 3821);
  assert.ok(outputBytes > 13_000_000 && outputBytes < 32 * 1024 * 1024,
    'the review-only case must exercise the complete large Python response');

  const { request_id: _retryRequestId, ...stableResponse } = parsed;

  const factRequest: SemanticFactExtractionRequest = {
    schema_version: 'semantic-fact-extraction-request-v1',
    owner_user_id: 'authorized-review-only-owner',
    project_id: 'authorized-rq-202509-review-only',
    input_revision: 1,
    input_hash: sha('authorized review-only input revision'),
    issuer_identity_record_id: 'reviewed-rq-identity',
    issuer_identity_version: 1,
    issuer_identity_hash: sha('authorized review-only identity binding'),
    entity_id: 'authorized-rq-entity',
    material_id: file.file_id,
    material_version: 1,
    material_sha256: contentHash,
    parse_snapshot_id: 'authorized-rq-review-only-snapshot',
    parse_response_sha256: sha(canonical(stableResponse)),
    parser_version: parsed.parser_version,
    records: parsed.records,
  };
  const mapped = await createNativeFinancialFactExtractor(async () => ({
    status: parsed.status,
    warnings: parsed.warnings,
  })).extract(factRequest);

  assert.equal(mapped.facts.length, 0, 'uncertain cached formula results must never become facts');
  assert.equal(mapped.needs_review.length, 1);
  assert.equal(mapped.needs_review[0]?.reason_code, 'PARSER_STATUS_OR_WARNING_NEEDS_CONFIRMATION');
  assert.equal(mapped.needs_review[0]?.evidence_refs.length, 32, 'review evidence refs must stay bounded');
  const evidenceIds = new Set(parsed.records.map((record) => record.record_id));
  assert.ok(mapped.needs_review[0]!.evidence_refs.every((recordId) => evidenceIds.has(recordId)),
    'review refs must point back to parser evidence');
});
