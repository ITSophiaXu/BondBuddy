import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runDocumentParserToFile, type DocumentParseRequest } from './document-parser.js';

type RegisteredPdf = {
  file_id: string;
  path: string;
  media_type: string;
  bytes: number;
  sha256: string;
  page_count: number;
};

type Manifest = { cases: Array<{ case_id: string; files: RegisteredPdf[] }> };
type PdfRecord = {
  locator_type: string;
  locator: { page: number; line: number; bbox: { x0: number; top: number; x1: number; bottom: number } };
  literal_quote: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestRoot = join(repoRoot, 'tests/samples/2026-09-25');
const localPython = join(repoRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const pythonExecutable = process.env.BB_PYTHON?.trim() || (existsSync(localPython)
  ? localPython
  : process.platform === 'win32' ? 'python' : 'python3');
const optedIn = process.env.BB_RUN_AUTHORIZED_QX_MIXED_PDF === '1';
const PDF_MEDIA = 'application/pdf';
const EXPECTED_SHA256 = 'f6ab6dae2d70f09390915ea9d3eeb7a755df51d3307f1eb204ae1243ed971844';
const EXPECTED_BYTES = 6_960_431;

// Opt in with BB_RUN_AUTHORIZED_QX_MIXED_PDF=1. Use .venv from python/requirements.txt,
// or set BB_PYTHON to an interpreter with the document parser dependencies installed.
test('authorized qx-202606-02 mixed-scan PDF keeps native anchors and marks scanned pages for review', {
  skip: !optedIn
    ? 'set BB_RUN_AUTHORIZED_QX_MIXED_PDF=1 to run the authorized mixed-scan PDF parser regression'
    : false,
}, async () => {
  const manifest = JSON.parse(await readFile(join(manifestRoot, 'manifest.json'), 'utf8')) as Manifest;
  const sample = manifest.cases.find((entry) => entry.case_id === 'qx-202606');
  assert.ok(sample, 'authorized qx-202606 case must be present');
  const registered = sample.files.find((entry) => entry.file_id === 'qx-202606-02');
  assert.ok(registered, 'manifest must register qx-202606-02');
  assert.equal(registered.media_type, PDF_MEDIA);
  assert.equal(registered.bytes, EXPECTED_BYTES);
  assert.equal(registered.sha256, EXPECTED_SHA256);
  assert.equal(registered.page_count, 74);

  const sourcePath = resolve(manifestRoot, registered.path);
  assert.ok(sourcePath.startsWith(`${resolve(manifestRoot)}/`), 'registered PDF path must stay inside the authorized sample directory');
  const sourceBytes = await readFile(sourcePath);
  assert.equal(sourceBytes.byteLength, registered.bytes, 'authorized PDF byte size must match manifest');
  assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), registered.sha256,
    'authorized PDF SHA-256 must match manifest');

  const staging = await mkdtemp(join(tmpdir(), 'bb-authorized-qx-pdf-'));
  try {
    const recordsPath = join(staging, 'records.ndjson');
    const request: DocumentParseRequest = {
      schema_version: 'document-parse-request-v1',
      request_id: 'authorized-qx-202606-02-pdf-regression',
      options: {},
      material: {
        material_id: registered.file_id,
        material_version: 1,
        media_type: PDF_MEDIA,
        sha256: registered.sha256,
        authorized_local_path: sourcePath,
      },
    };
    const parsed = await runDocumentParserToFile(request, recordsPath, { pythonExecutable, repoRoot });
    assert.equal(parsed.response.parser_version, 'bondbuddy-document-parser-1.0.6');
    assert.equal(parsed.response.status, 'needs_confirmation');
    const document = parsed.response.document as { page_count: number; pages_without_native_text: number[]; pages_with_images: number[] };
    assert.equal(document.page_count, 74);
    // The manifest's pypdf precheck lists every page without extracted text, but is not the
    // parser's ground truth. This regression pins only the independently visually confirmed scan page 3.
    assert.ok(document.pages_without_native_text.includes(3), 'known scanned audit-opinion page 3 must remain uncovered');
    assert.ok(parsed.response.warnings.some((warning) => warning.code === 'PDF_PAGES_WITHOUT_TEXT'));
    assert.ok(parsed.response.warnings.some((warning) => warning.code === 'PDF_IMAGES_NOT_OCRD'),
      'native parser must not imply OCR ran on image pages');

    let anchor: PdfRecord | undefined;
    let pageThreeRecordCount = 0;
    for await (const line of createInterface({ input: createReadStream(recordsPath), crlfDelay: Infinity })) {
      if (!line) continue;
      const record = JSON.parse(line) as PdfRecord;
      if (record.locator?.page === 3) pageThreeRecordCount++;
      if (!anchor && record.locator_type === 'pdf_bbox' && Number.isSafeInteger(record.locator?.page) &&
          !document.pages_without_native_text.includes(record.locator.page) && typeof record.literal_quote === 'string' &&
          record.literal_quote.trim().length > 0 && record.locator.bbox &&
          Number.isFinite(record.locator.bbox.x0) && Number.isFinite(record.locator.bbox.top) &&
          Number.isFinite(record.locator.bbox.x1) && Number.isFinite(record.locator.bbox.bottom) &&
          record.locator.bbox.x1 > record.locator.bbox.x0 && record.locator.bbox.bottom > record.locator.bbox.top) {
        anchor = record;
      }
    }
    assert.equal(parsed.recordCount > 0, true, 'mixed PDF must yield native-text evidence records');
    assert.equal(pageThreeRecordCount, 0, 'a page with no native text must not receive parser text records');
    assert.ok(anchor, 'at least one native PDF record must have a real page and positive bbox locator');

    const verifySourceAnchor = String.raw`
import json, sys, pdfplumber
verification = json.load(sys.stdin)
path = verification["source_path"]
anchor = verification["anchor"]
with pdfplumber.open(path) as pdf:
    page = pdf.pages[anchor["page"] - 1]
    recovered = page.crop((anchor["bbox"]["x0"], anchor["bbox"]["top"], anchor["bbox"]["x1"], anchor["bbox"]["bottom"])).extract_text()
print(json.dumps({"source_quote_matches_bbox": recovered == anchor["quote"]}, separators=(",", ":")))
`;
    const checked = spawnSync(pythonExecutable, ['-c', verifySourceAnchor], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify({
        source_path: sourcePath,
        anchor: { page: anchor.locator.page, bbox: anchor.locator.bbox, quote: anchor.literal_quote },
      }),
      maxBuffer: 1024 * 1024,
    });
    assert.equal(checked.status, 0, 'independent pdfplumber source-anchor check must complete');
    const anchorCheck = JSON.parse(checked.stdout) as { source_quote_matches_bbox: boolean };
    assert.equal(anchorCheck.source_quote_matches_bbox, true,
      'native record literal_quote must be recoverable from its original PDF page bbox');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});
