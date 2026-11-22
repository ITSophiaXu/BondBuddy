import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  runDocumentParser,
  type DocumentParseRequest,
  type DocumentParseResponse,
} from './document-parser.js';
import {
  proposeTargetReportingPeriods,
  type NativePeriodEvidenceSnapshot,
} from './target-period-candidates.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sampleRoot = join(repositoryRoot, 'tests/samples/2026-09-25');
const pythonExecutable =
  process.env.BB_PYTHON?.trim() || join(repositoryRoot, '.venv', 'bin', 'python');
const optedIn = process.env.BB_RUN_AUTHORIZED_ZQ202312_TARGET_PERIOD_CANDIDATES === '1';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CUTOFF = '2023-12-31'; // User-confirmed target intent used only to label extracted evidence relative to cutoff.
const FILES = {
  historical: {
    id: 'zq-202312-01',
    bytes: 623_540,
    sha256: '8b7dab59cc9d0cc86da5fa06af2fcc9d9dfc84012cbb6460e5e92a650c73a0be',
    mediaType: DOCX,
  },
  financial: {
    id: 'zq-202312-02',
    bytes: 48_915,
    sha256: '1904db38788dacc07603234ac83be81548493321abc45905601422a6a9b30a2f',
    mediaType: XLSX,
  },
} as const;
const PARSER_VERSION = 'bondbuddy-document-parser-1.0.8';

type ManifestAnchor = { readonly locator: string; readonly quote: string };
type ManifestFile = {
  readonly file_id: string;
  readonly path: string;
  readonly upload_role: string;
  readonly media_type: DocumentParseRequest['material']['media_type'];
  readonly bytes: number;
  readonly sha256: string;
  readonly evidence: readonly ManifestAnchor[];
};
type Manifest = {
  readonly cases: readonly { readonly case_id: string; readonly files: readonly ManifestFile[] }[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('UNSERIALIZABLE_PARSE_EVIDENCE');
  return encoded;
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function manifestLocator(record: DocumentParseResponse['records'][number]): string | null {
  if (record.locator_type === 'xlsx_cell')
    return `${String(record.locator.sheet)}!${String(record.locator.cell)}`;
  return null;
}

async function parse(
  file: ManifestFile,
  requestId: string,
): Promise<{ response: DocumentParseResponse; snapshot: NativePeriodEvidenceSnapshot }> {
  const sourcePath = resolve(sampleRoot, file.path);
  const relativeSource = relative(resolve(sampleRoot), sourcePath);
  assert.ok(
    relativeSource.length > 0 &&
      relativeSource !== '..' &&
      !relativeSource.startsWith(`..${sep}`) &&
      !isAbsolute(relativeSource),
    'manifest source path stays inside the authorized sample directory on Windows and POSIX',
  );
  const sourceBytes = await readFile(sourcePath);
  assert.deepEqual(
    [sourceBytes.byteLength, sha256(sourceBytes)],
    [file.bytes, file.sha256],
    'source bytes match the registered size and SHA-256 before parsing',
  );

  const request: DocumentParseRequest = {
    schema_version: 'document-parse-request-v1',
    request_id: requestId,
    material: {
      material_id: file.file_id,
      material_version: 1,
      media_type: file.media_type as DocumentParseRequest['material']['media_type'],
      sha256: file.sha256,
      authorized_local_path: sourcePath,
    },
    options: {},
  };
  const response = await runDocumentParser(request, {
    pythonExecutable,
    repoRoot: repositoryRoot,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  assert.equal(response.parser_version, PARSER_VERSION);
  assert.notEqual(
    response.status,
    'failed',
    'registered electronic material should parse without a terminal parser failure',
  );

  for (const sourceAnchor of file.evidence) {
    const matches = response.records.filter(
      (record) =>
        record.literal_quote.trim() === sourceAnchor.quote.trim() &&
        (record.locator_type !== 'xlsx_cell' || manifestLocator(record) === sourceAnchor.locator),
    );
    const matched = matches.length === 1 ? matches[0] : undefined;
    assert.ok(
      matched && matched.literal_quote.trim() === sourceAnchor.quote.trim(),
      `registered source anchor ${sourceAnchor.locator} must uniquely match exact native output`,
    );
  }

  const { request_id: _requestId, ...stableResponse } = response;
  const responseSha256 = sha256(canonical(stableResponse));
  return {
    response,
    snapshot: {
      method: 'native_text',
      snapshot_id: `${file.file_id}-${responseSha256.slice(0, 24)}`,
      response_sha256: responseSha256,
      material_id: file.file_id,
      material_version: 1,
      material_sha256: file.sha256,
      media_type: file.media_type,
      parser_version: response.parser_version,
      status: response.status,
      warnings: response.warnings,
      records: response.records.map((record) => ({
        ...record,
        record_sha256: sha256(canonical(record)),
      })),
    },
  };
}

test(
  'authorized zq-202312 DOCX and XLSX produce only exact-evidence pending candidates',
  {
    skip: optedIn
      ? false
      : 'set BB_RUN_AUTHORIZED_ZQ202312_TARGET_PERIOD_CANDIDATES=1 to parse the authorized DOCX and XLSX locally',
  },
  async () => {
    const manifest = JSON.parse(
      await readFile(join(sampleRoot, 'manifest.json'), 'utf8'),
    ) as Manifest;
    const sampleCase = manifest.cases.find((item) => item.case_id === 'zq-202312');
    assert.ok(sampleCase, 'the case must be registered in the authorized sample manifest');
    const historicalFile = sampleCase.files.find((file) => file.file_id === FILES.historical.id);
    const financialFile = sampleCase.files.find((file) => file.file_id === FILES.financial.id);
    assert.ok(
      historicalFile && financialFile,
      'the registered historical DOCX and financial XLSX must exist',
    );
    assert.deepEqual(
      [
        historicalFile.upload_role,
        historicalFile.media_type,
        historicalFile.bytes,
        historicalFile.sha256,
      ],
      ['historical', DOCX, FILES.historical.bytes, FILES.historical.sha256],
    );
    assert.deepEqual(
      [
        financialFile.upload_role,
        financialFile.media_type,
        financialFile.bytes,
        financialFile.sha256,
      ],
      ['financial', XLSX, FILES.financial.bytes, FILES.financial.sha256],
    );

    const [historical, financial] = await Promise.all([
      parse(historicalFile, 'authorized-zq202312-period-historical'),
      parse(financialFile, 'authorized-zq202312-period-financial'),
    ]);
    const result = proposeTargetReportingPeriods({
      reporting_cutoff: CUTOFF,
      // #76 candidate proposals consume locked financial/audit material. Parse the paired history
      // DOCX to retain independently checkable historical source evidence, but do not pass it as
      // target-period evidence or let its periods become candidates.
      locked_materials: [
        {
          material_id: financialFile.file_id,
          material_version: 1,
          material_sha256: financialFile.sha256,
          role: financialFile.upload_role,
        },
      ],
      snapshots: [financial.snapshot],
    });

    assert.equal(result.status, 'needs_confirmation');
    assert.equal(result.completeness, 'not_determined');
    assert.ok(
      result.source_snapshot_pins.some(
        (pin) =>
          pin.material_id === financialFile.file_id &&
          pin.material_sha256 === FILES.financial.sha256,
      ),
    );
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.end, candidate.scope]),
      [
        ['2021-12-31', 'consolidated'],
        ['2021-12-31', 'parent'],
        ['2022-12-31', 'consolidated'],
        ['2022-12-31', 'parent'],
        ['2023-12-31', 'consolidated'],
        ['2023-12-31', 'parent'],
      ],
    );
    assert.ok(
      result.candidates.every((candidate) => candidate.status === 'needs_confirmation'),
      'financial parser evidence can propose periods but cannot approve them',
    );
    assert.ok(
      result.candidates.every((candidate) =>
        candidate.evidence.every(
          (reference) =>
            reference.material_id === financialFile.file_id &&
            reference.material_sha256 === FILES.financial.sha256,
        ),
      ),
      'candidate provenance must stay inside the exact locked financial report; parsed historical periods do not become target candidates',
    );
    assert.ok(
      result.candidates.every((candidate) =>
        candidate.anchors
          .filter((anchor) => anchor.kind === 'period_end')
          .every((anchor) => anchor.evidence.quote.includes(anchor.raw_period_token)),
      ),
      'every period-end token must be present in its exact parser quote',
    );
    assert.ok(
      result.candidates.every(
        (candidate) =>
          candidate.anchors.some((anchor) => anchor.kind === 'table_header') &&
          candidate.anchors.some((anchor) => anchor.kind === 'scope') &&
          candidate.anchors.some((anchor) => anchor.kind === 'period_end'),
      ),
      'each candidate retains financial-header, reporting-scope, and exact period-token anchors',
    );
    assert.ok(
      result.candidates.every((candidate) =>
        candidate.pending_reasons.includes('missing_explicit_entity_anchor'),
      ),
      'period extraction does not invent issuer identity when the financial header lacks an entity anchor',
    );

    console.log(
      `authorized zq-202312: parsed historical records=${historical.response.records.length}; financial records=${financial.response.records.length}; pending candidates=${result.candidates.map((candidate) => `${candidate.end}/${candidate.scope}`).join(', ')}`,
    );

    for (const [path, expectedHash] of [
      [resolve(sampleRoot, historicalFile.path), FILES.historical.sha256],
      [resolve(sampleRoot, financialFile.path), FILES.financial.sha256],
    ] as const)
      assert.equal(
        sha256(await readFile(path)),
        expectedHash,
        'authorized source bytes remain unchanged after parsing',
      );
  },
);
