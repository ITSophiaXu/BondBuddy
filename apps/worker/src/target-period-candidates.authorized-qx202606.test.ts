import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  runDocumentParser,
  runDocumentParserToFile,
  type DocumentParseRequest,
  type DocumentParseResponse,
} from './document-parser.js';
import { recognizeHistoricalNativeText } from './historical-native-recognition.js';
import {
  proposeTargetReportingPeriods,
  type NativePeriodEvidenceSnapshot,
} from './target-period-candidates.js';

type ManifestFile = {
  readonly file_id: string;
  readonly path: string;
  readonly upload_role: string;
  readonly media_type: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly period?: { readonly supplied_cutoff: string; readonly status: string };
  readonly page_count?: number;
  readonly pages_without_extracted_text?: readonly number[];
  readonly evidence?: readonly { readonly locator: string; readonly quote: string }[];
};
type Manifest = {
  readonly cases: readonly { readonly case_id: string; readonly files: readonly ManifestFile[] }[];
};
type StreamRecord = DocumentParseResponse['records'][number];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sampleRoot = join(repositoryRoot, 'tests/samples/2026-09-25');
const localPython = join(
  repositoryRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const pythonExecutable =
  process.env.BB_PYTHON?.trim() ||
  (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
const optedIn = process.env.BB_RUN_AUTHORIZED_QX202606_TARGET_PERIODS === '1';
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PARSER_VERSION = 'bondbuddy-document-parser-1.0.8';
const REPORTING_CUTOFF = '2026-06-30'; // Task intent only; never passed to source-profile recognition.
const tesseractLanguages = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
const hasChineseOcrLanguage =
  tesseractLanguages.status === 0 && /^chi_sim$/m.test(tesseractLanguages.stdout);
const FILES = {
  historical: {
    id: 'qx-202606-01',
    bytes: 6_775_574,
    sha256: '667bfa4e3872d69ae8364b6ebd1753f3f2bb65a9d362e9a49daaab8c7234ab14',
  },
  audit2024: {
    id: 'qx-202606-02',
    bytes: 6_960_431,
    sha256: 'f6ab6dae2d70f09390915ea9d3eeb7a755df51d3307f1eb204ae1243ed971844',
  },
  audit2025: {
    id: 'qx-202606-03',
    bytes: 7_227_129,
    sha256: '82a95dcd65ad1d1595fb2f340fa1912f540fbaa6ddec41e28c56ae971002a891',
  },
  interim2026: {
    id: 'qx-202606-04',
    bytes: 348_036,
    sha256: '6fc2b04841cbcf53b42b9c35f4f6fa970c69b130e7bcb0e160372b4de760ea37',
  },
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('UNSERIALIZABLE_PARSE_EVIDENCE');
  return encoded;
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function readRecords(path: string): Promise<StreamRecord[]> {
  const records: StreamRecord[] = [];
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    if (line) records.push(JSON.parse(line) as StreamRecord);
  }
  return records;
}

function requestFor(
  file: ManifestFile,
  sourcePath: string,
  requestId: string,
): DocumentParseRequest {
  return {
    schema_version: 'document-parse-request-v1',
    request_id: requestId,
    options: {},
    material: {
      material_id: file.file_id,
      material_version: 1,
      media_type: file.media_type as DocumentParseRequest['material']['media_type'],
      sha256: file.sha256,
      authorized_local_path: sourcePath,
    },
  };
}

async function loadPdfSnapshot(
  file: ManifestFile,
  staging: string,
): Promise<NativePeriodEvidenceSnapshot & { response: DocumentParseResponse }> {
  const sourcePath = resolve(sampleRoot, file.path);
  const relativePath = relative(resolve(sampleRoot), sourcePath);
  assert.ok(
    relativePath.length > 0 &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath),
    'manifest source path stays within the authorized sample directory',
  );
  const bytes = await readFile(sourcePath);
  assert.deepEqual(
    [bytes.byteLength, sha256(bytes)],
    [file.bytes, file.sha256],
    `${file.file_id} source bytes match the registered manifest`,
  );
  const result = await runDocumentParserToFile(
    requestFor(file, sourcePath, `authorized-${file.file_id}-period-regression`),
    join(staging, `${file.file_id}.ndjson`),
    { pythonExecutable, repoRoot: repositoryRoot, maxOutputBytes: 256 * 1024 * 1024 },
  );
  assert.equal(result.response.parser_version, PARSER_VERSION);
  const records = await readRecords(result.recordsPath);
  assert.equal(records.length, result.recordCount);
  const response = { ...result.response, records } as DocumentParseResponse;
  const { request_id: _requestId, ...stableResponse } = response;
  return {
    method: 'native_text',
    snapshot_id: `${file.file_id}-${sha256(canonical(stableResponse)).slice(0, 20)}`,
    response_sha256: sha256(canonical(stableResponse)),
    material_id: file.file_id,
    material_version: 1,
    material_sha256: file.sha256,
    media_type: PDF,
    parser_version: response.parser_version,
    status: response.status,
    warnings: response.warnings,
    records: records.map((record) => ({ ...record, record_sha256: sha256(canonical(record)) })),
    response,
  };
}

test(
  'authorized qx-202606 source profile stays separate from native financial-period candidates',
  {
    skip: optedIn
      ? false
      : 'set BB_RUN_AUTHORIZED_QX202606_TARGET_PERIODS=1 to parse the authorized qx-202606 materials locally',
  },
  async () => {
    const manifest = JSON.parse(
      await readFile(join(sampleRoot, 'manifest.json'), 'utf8'),
    ) as Manifest;
    const sample = manifest.cases.find((item) => item.case_id === 'qx-202606');
    assert.ok(sample, 'authorized qx-202606 case is registered');
    const files = new Map(sample.files.map((file) => [file.file_id, file]));
    const historical = files.get(FILES.historical.id);
    assert.ok(historical);
    assert.deepEqual(
      [historical.media_type, historical.bytes, historical.sha256],
      [DOCX, FILES.historical.bytes, FILES.historical.sha256],
    );
    const historicalBytes = await readFile(resolve(sampleRoot, historical.path));
    assert.deepEqual(
      [historicalBytes.byteLength, sha256(historicalBytes)],
      [historical.bytes, historical.sha256],
    );
    const sourceResponse = await runDocumentParser(
      requestFor(
        historical,
        resolve(sampleRoot, historical.path),
        'authorized-qx-historical-source-profile',
      ),
      { pythonExecutable, repoRoot: repositoryRoot, maxOutputBytes: 64 * 1024 * 1024 },
    );
    const sourceProfile = recognizeHistoricalNativeText(sourceResponse, { profileVersion: 1 });
    assert.equal(sourceProfile.state, 'needs_confirmation');
    for (const end of ['2021-12-31', '2022-12-31', '2023-06-30']) {
      assert.ok(
        sourceProfile.reporting_periods.some(
          (period) => period.end === end && period.status === 'needs_confirmation',
        ),
        `historical source recognition retains ${end} as pending evidence`,
      );
    }

    const audit2024 = files.get(FILES.audit2024.id);
    const audit2025 = files.get(FILES.audit2025.id);
    const interim2026 = files.get(FILES.interim2026.id);
    assert.ok(audit2024 && audit2025 && interim2026);
    for (const [file, expected] of [
      [audit2024, FILES.audit2024],
      [audit2025, FILES.audit2025],
      [interim2026, FILES.interim2026],
    ] as const) {
      assert.deepEqual(
        [file.media_type, file.bytes, file.sha256],
        [PDF, expected.bytes, expected.sha256],
      );
    }
    assert.deepEqual(
      [audit2024.page_count, audit2024.period?.supplied_cutoff, audit2024.period?.status],
      [74, '2024-12-31', 'observed_audit_opinion'],
    );
    assert.deepEqual(
      [audit2025.page_count, audit2025.period?.supplied_cutoff, audit2025.period?.status],
      [70, '2025-12-31', 'observed_audit_opinion'],
    );
    assert.deepEqual(
      [interim2026.page_count, interim2026.period?.supplied_cutoff, interim2026.period?.status],
      [10, '2026-06-30', 'observed_header'],
    );

    const staging = await mkdtemp(join(tmpdir(), 'bb-authorized-qx-periods-'));
    try {
      const [snapshot2024, snapshot2025, snapshot2026] = await Promise.all([
        loadPdfSnapshot(audit2024, staging),
        loadPdfSnapshot(audit2025, staging),
        loadPdfSnapshot(interim2026, staging),
      ]);
      assert.equal(snapshot2024.response.document.page_count, 74);
      assert.equal(snapshot2025.response.document.page_count, 70);
      assert.equal(snapshot2026.response.document.page_count, 10);
      {
        const blankPages = snapshot2024.response.document.pages_without_native_text as number[];
        assert.ok(
          blankPages.includes(3),
          '2024 audit-opinion page 3 remains explicitly uncovered by native parsing',
        );
        assert.equal(
          snapshot2024.records.some((record) => record.locator.page === 3),
          false,
          '2024 has no fabricated native text evidence on scanned audit-opinion page 3',
        );
        assert.ok(
          (snapshot2025.response.document.pages_without_native_text as number[]).length > 0,
          '2025 still has separately identified scanned pages even though the opinion page has extractable text',
        );
        assert.ok(
          snapshot2025.records.some(
            (record) => record.locator.page === 3 && /审计意见/.test(record.literal_quote),
          ),
          '2025 page 3 is extractable audit-opinion text, distinct from a statement header',
        );
        assert.ok(
          snapshot2024.warnings.some((warning) => warning.code === 'PDF_IMAGES_NOT_OCRD') &&
            snapshot2025.warnings.some((warning) => warning.code === 'PDF_IMAGES_NOT_OCRD'),
          'native parser explicitly says image content was not OCR processed',
        );
      }
      assert.deepEqual(
        snapshot2024.response.document.pages_without_native_text,
        audit2024.pages_without_extracted_text,
      );
      assert.deepEqual(
        snapshot2025.response.document.pages_without_native_text,
        audit2025.pages_without_extracted_text,
      );
      assert.deepEqual(snapshot2026.response.document.pages_without_native_text, []);

      // The 2024 opinion page is scanned, while 2025's opinion page has native text.
      // Neither kind of opinion page may substitute for visible financial-body headers.
      const visiblePeriodLine = (snapshot: typeof snapshot2024, pattern: RegExp, minimumPage = 1) =>
        snapshot.records.find(
          (record) =>
            Number.isSafeInteger(record.locator.page) &&
            Number(record.locator.page) >= minimumPage &&
            !(snapshot.response.document.pages_without_native_text as number[]).includes(
              Number(record.locator.page),
            ) &&
            pattern.test(record.literal_quote),
        );
      const year2024 = visiblePeriodLine(snapshot2024, /2024\s*年度/, 14);
      const year2025 = visiblePeriodLine(snapshot2025, /2025\s*年度/, 14);
      const half2026 = visiblePeriodLine(snapshot2026, /2026\s*年\s*1\s*[-—–]\s*6\s*月/);
      assert.ok(
        year2024 && Number(year2024.locator.page) >= 14,
        '2024 period comes from a visible body line, not scanned audit-opinion page 3',
      );
      assert.ok(
        year2025 && Number(year2025.locator.page) >= 14,
        '2025 period comes from a visible body line, not report-number year 2026 or scanned page 3',
      );
      assert.ok(
        half2026 && Number(half2026.locator.page) >= 3,
        '2026 interim period comes from a native financial statement header',
      );
      assert.match(year2024.literal_quote, /2024\s*年度/);
      assert.match(year2025.literal_quote, /2025\s*年度/);
      assert.match(half2026.literal_quote, /2026\s*年\s*1\s*[-—–]\s*6\s*月/);

      const lockedMaterials = [audit2024, audit2025, interim2026].map((file) => ({
        material_id: file.file_id,
        material_version: 1,
        material_sha256: file.sha256,
        role: file.upload_role,
      }));
      assert.deepEqual(
        lockedMaterials.map((material) => material.role).sort(),
        ['audit', 'audit', 'interimFinancial'],
        'the target-period input excludes the historical prospectus and the absent 2026 interim notes',
      );
      const result = proposeTargetReportingPeriods({
        reporting_cutoff: REPORTING_CUTOFF,
        locked_materials: lockedMaterials,
        snapshots: [snapshot2024, snapshot2025, snapshot2026],
      });
      assert.equal(result.status, 'needs_confirmation');
      assert.equal(result.completeness, 'not_determined');
      assert.equal(result.reporting_cutoff, REPORTING_CUTOFF);
      assert.deepEqual(
        result.locked_material_pins.map((pin) => pin.material_id),
        [FILES.audit2024.id, FILES.audit2025.id, FILES.interim2026.id].sort(),
      );
      assert.ok(
        result.candidates.every((candidate) => candidate.status === 'needs_confirmation'),
        'native parse proposals never confirm target intent or underlying financial facts',
      );
      for (const end of ['2024-12-31', '2025-12-31', '2026-06-30']) {
        const candidate = result.candidates.find((item) => item.end === end);
        const bodyPageFloor = end === '2026-06-30' ? 3 : 14;
        assert.ok(candidate, `${end} is proposed from the visible body/header evidence`);
        assert.ok(candidate.pending_reasons.length > 0, `${end} retains explicit review reasons`);
        assert.ok(
          candidate.anchors.some(
            (anchor) =>
              anchor.kind === 'period_end' && anchor.evidence.quote.includes(end.slice(0, 4)),
          ),
          `${end} retains a period-end quote anchor`,
        );
        assert.ok(
          candidate.anchors.some(
            (anchor) =>
              anchor.kind === 'table_header' &&
              Number(anchor.evidence.locator?.page) >= bodyPageFloor &&
              /财务报表|资产负债表|利润表|现金流量表/.test(anchor.evidence.quote),
          ),
          `${end} retains a body table/header anchor distinct from the auditor opinion`,
        );
        assert.ok(
          candidate.anchors.some(
            (anchor) =>
              anchor.kind === 'entity' &&
              anchor.evidence.quote.includes('杞县豫资城乡发展建设有限公司'),
          ) || candidate.pending_reasons.includes('missing_explicit_entity_anchor'),
          `${end} either retains an exact issuer-name source line or explicitly remains pending for it`,
        );
        assert.ok(
          candidate.evidence.every(
            (ref) =>
              lockedMaterials.some(
                (material) =>
                  material.material_id === ref.material_id &&
                  material.material_sha256 === ref.material_sha256,
              ) && /^[a-f0-9]{64}$/.test(ref.record_sha256),
          ),
          `${end} evidence remains pinned to the exact authorized material and parser record hashes`,
        );
      }
      const candidate2024 = result.candidates.find((item) => item.end === '2024-12-31')!;
      const candidate2025 = result.candidates.find((item) => item.end === '2025-12-31')!;
      const candidate2026 = result.candidates.find((item) => item.end === '2026-06-30')!;
      assert.ok(candidate2024.evidence.some((ref) => ref.material_id === audit2024.file_id));
      assert.ok(candidate2025.evidence.some((ref) => ref.material_id === audit2025.file_id));
      assert.ok(candidate2026.evidence.some((ref) => ref.material_id === interim2026.file_id));
      assert.ok(candidate2024.anchors.every((anchor) => anchor.evidence.locator?.page !== 3));
      assert.ok(candidate2025.anchors.every((anchor) => anchor.evidence.locator?.page !== 3));
      assert.ok(
        !result.candidates.some((candidate) =>
          ['2021-12-31', '2022-12-31', '2023-06-30'].includes(candidate.end ?? ''),
        ),
        'source-prospectus reporting periods are not copied into target candidates',
      );
      assert.ok(
        result.source_snapshot_pins.every((pin) => pin.material_id !== historical.file_id),
        'historical profile material is not passed as a target financial-period source',
      );

      const unchanged = await Promise.all(
        [audit2024, audit2025, interim2026].map(async (file) => {
          const bytes = await readFile(resolve(sampleRoot, file.path));
          return [file.file_id, sha256(bytes)] as const;
        }),
      );
      assert.deepEqual(
        unchanged.map(([id, digest]) => [id, digest]),
        [audit2024, audit2025, interim2026].map((file) => [file.file_id, file.sha256]),
        'all authorized originals remain byte-for-byte unchanged',
      );
      const periods = [
        ...new Map(
          result.candidates.map((candidate) => [
            candidate.end,
            {
              end: candidate.end,
              scopes: [
                ...new Set(
                  result.candidates
                    .filter((item) => item.end === candidate.end)
                    .map((item) => item.scope),
                ),
              ].sort(),
              statuses: [
                ...new Set(
                  result.candidates
                    .filter((item) => item.end === candidate.end)
                    .map((item) => item.status),
                ),
              ],
              files: [
                ...new Set(
                  result.candidates
                    .filter((item) => item.end === candidate.end)
                    .flatMap((item) => item.evidence.map((ref) => ref.material_id)),
                ),
              ].sort(),
            },
          ]),
        ).values(),
      ];
      console.log(
        `authorized qx-202606 target periods: ${JSON.stringify(periods)}; 2024 opinion page 3 scanned/uncovered; 2025 opinion page 3 text excluded from table-header candidates; OCR=not_run (chi_sim ${hasChineseOcrLanguage ? 'available' : 'missing'}); annual-note gap remains unresolved`,
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  },
);
