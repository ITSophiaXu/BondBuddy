import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { azureBlobs, digest, verifiedMedia, verifiedMediaFile } from './data.js';
import { createServer } from './server.js';
import { runInspectionWorker } from './upload-safety.js';
import {
  activeDocxSample, activeSvgDocxSample, compressedBombSample, csvFormulaSample, csvSample, DOCX, docxSample,
  encryptedOfficeSample, encryptedZipSample, entryCountBombSample, expandedSizeBombSample, externalLinkPartXlsxSample, externalRelationshipDocxSample, externalRelationshipXlsxSample, JPEG, jpegSample, CSV,
  macroDefaultDocxSample, macroDocxSample, neutralExtensionDocxSample, nestedGzipDocxSample, PDF, pdfSample, PNG, pngSample, PPTX, pptxSample, TEXT, textSample,
  XLSX, xlsxSample, xlsxPartNameSample, xlsxRelationshipTargetSample, xlsxDeflatedDirectorySample
} from './upload-safety.samples.js';

const connection = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';

// Every sample is inspected twice: from memory and from a spooled file. The file path must give
// the same verdict, status, code and message as the in-memory inspection (parity).
async function spooled<T>(bytes: Buffer, use: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'bb-inspect-'));
  const path = join(directory, 'sample.part');
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    return await use(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function outcome(inspection: Promise<string>): Promise<unknown> {
  try { return { ok: await inspection }; }
  catch (error) { const e = error as Error & { status: number; code: string }; return { status: e.status, code: e.code, message: e.message }; }
}

async function expectInspectionFailure(bytes: Buffer, mediaType: string, status: number, code: string, reason?: string): Promise<void> {
  const memory = await outcome(verifiedMedia(bytes, mediaType));
  assert.equal((memory as { status: number }).status, status);
  assert.equal((memory as { code: string }).code, code);
  if (reason) {
    await assert.rejects(verifiedMedia(bytes, mediaType), (error: unknown) => (error as { uploadReason?: string }).uploadReason === reason);
    await spooled(bytes, path => assert.rejects(verifiedMediaFile(path, bytes.length, mediaType), (error: unknown) => (error as { uploadReason?: string }).uploadReason === reason));
  }
  assert.deepEqual(await spooled(bytes, path => outcome(verifiedMediaFile(path, bytes.length, mediaType))), memory, `file/memory parity for ${code}`);
}

async function expectStructureDetail(bytes: Buffer, detail: string): Promise<void> {
  const matches = (error: unknown) => {
    const failure = error as { code?: string; uploadReason?: string; uploadDetail?: string };
    return failure.code === 'MATERIAL_UNREADABLE' && failure.uploadReason === 'structure_invalid' && failure.uploadDetail === detail;
  };
  await assert.rejects(verifiedMedia(bytes, XLSX), matches);
  await spooled(bytes, path => assert.rejects(verifiedMediaFile(path, bytes.length, XLSX), matches));
}

/** Rewrite the declared expanded size of one stored part in both its local and central headers. */
function lieAboutExpandedSize(zip: Buffer, name: string, declared: number): Buffer {
  const copy = Buffer.from(zip);
  const raw = Buffer.from(name);
  const local = copy.indexOf(raw);
  const central = copy.indexOf(raw, local + raw.length);
  assert.ok(local > 30 && central > local, 'part headers found');
  assert.equal(copy.readUInt32LE(local - 30), 0x04034b50);
  assert.equal(copy.readUInt32LE(central - 46), 0x02014b50);
  assert.equal(copy.readUInt16LE(local - 30 + 6) & 0x0008, 0, 'sizes live in the headers');
  copy.writeUInt32LE(declared, local - 30 + 22);
  copy.writeUInt32LE(declared, central - 46 + 24);
  return copy;
}

test('bounded upload inspection accepts valid synthetic samples for the seven shared MIME types', async () => {
  const valid = [
    { name: 'synthetic.pdf', mediaType: PDF, bytes: pdfSample() },
    { name: 'synthetic.docx', mediaType: DOCX, bytes: await docxSample() },
    { name: 'synthetic.docx-with-neutral-binary-image', mediaType: DOCX, bytes: await neutralExtensionDocxSample('application/octet-stream', pngSample) },
    { name: 'synthetic.xlsx', mediaType: XLSX, bytes: await xlsxSample() },
    { name: 'synthetic.txt', mediaType: TEXT, bytes: textSample },
    { name: 'synthetic.csv', mediaType: CSV, bytes: csvSample },
    { name: 'synthetic-bom-quoted.csv', mediaType: CSV, bytes: Buffer.from('\uFEFF"label",amount\r\n"Synthetic", -100 \r\n') },
    { name: 'synthetic.png', mediaType: PNG, bytes: pngSample },
    { name: 'synthetic.jpg', mediaType: JPEG, bytes: jpegSample }
  ];
  for (const item of valid) {
    assert.equal(await verifiedMedia(item.bytes, item.mediaType), item.mediaType, item.name);
    assert.equal(await spooled(item.bytes, path => verifiedMediaFile(path, item.bytes.length, item.mediaType)), item.mediaType, `${item.name} from file`);
  }
});

test('authorized rq-202509 historical DOCX passes both inspection paths at its recorded hash', async () => {
  const sampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tests/samples/2026-09-25');
  const manifest = JSON.parse(await readFile(join(sampleRoot, 'manifest.json'), 'utf8')) as {
    cases: Array<{ case_id: string; files: Array<{ file_id: string; path: string; bytes: number; sha256: string }> }>;
  };
  const entry = manifest.cases.find(item => item.case_id === 'rq-202509')?.files.find(item => item.file_id === 'rq-202509-01');
  assert.ok(entry, 'authorized historical DOCX is listed in the manifest');
  assert.equal(entry.sha256, '51f77e36dcdc8b565f9a7b58ebf87cb6be4839a3444b8602df833e3fd61ef678');
  const path = join(sampleRoot, entry.path);
  const bytes = await readFile(path);
  assert.equal(bytes.length, entry.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  assert.equal(await verifiedMediaFile(path, bytes.length, DOCX), DOCX);
  assert.equal(await verifiedMedia(bytes, DOCX), DOCX);
});

test('authorized rq-202509 financial XLSX passes both inspection paths at its recorded hash', async () => {
  const sampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tests/samples/2026-09-25');
  const manifest = JSON.parse(await readFile(join(sampleRoot, 'manifest.json'), 'utf8')) as {
    cases: Array<{ case_id: string; files: Array<{ file_id: string; path: string; bytes: number; sha256: string }> }>;
  };
  const entry = manifest.cases.find(item => item.case_id === 'rq-202509')?.files.find(item => item.file_id === 'rq-202509-02');
  assert.ok(entry, 'authorized financial XLSX is listed in the manifest');
  const path = join(sampleRoot, entry.path);
  const bytes = await readFile(path);
  assert.equal(bytes.length, 424_900);
  assert.equal(bytes.length, entry.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  assert.equal(await verifiedMediaFile(path, bytes.length, XLSX), XLSX);
  assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
});

test('all four registered XLSX originals retain their recorded hashes and pass inspection', async () => {
  const sampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tests/samples/2026-09-25');
  const manifest = JSON.parse(await readFile(join(sampleRoot, 'manifest.json'), 'utf8')) as {
    cases: Array<{ files: Array<{ path: string; bytes: number; sha256: string }> }>;
  };
  const entries = manifest.cases.flatMap(item => item.files).filter(item => item.path.toLowerCase().endsWith('.xlsx'));
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    const path = join(sampleRoot, entry.path);
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
    assert.equal(await verifiedMediaFile(path, bytes.length, XLSX), XLSX);
  }
});

test('externalLink extension lists and markup compatibility branches remain passive', async () => {
  const prefix = '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x="urn:synthetic">';
  const book = '<externalBook r:id="rId1"><extLst><ext uri="urn:synthetic"><x:metadata><x:item>safe</x:item></x:metadata></ext></extLst></externalBook>';
  for (const body of [
    `${book}<extLst><ext uri="urn:synthetic"><x:metadata/></ext></extLst>`,
    `<mc:AlternateContent><mc:Choice Requires="x">${book}</mc:Choice><mc:Fallback><externalBook r:id="rId1"/></mc:Fallback></mc:AlternateContent>`
  ]) {
    const bytes = await externalLinkPartXlsxSample({ linkXml: `${prefix}${body}</externalLink>` });
    assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
    assert.equal(await spooled(bytes, path => verifiedMediaFile(path, bytes.length, XLSX)), XLSX);
  }
  const deep = '<x:n>'.repeat(260) + '</x:n>'.repeat(260);
  await expectInspectionFailure(await externalLinkPartXlsxSample({ linkXml: `${prefix}<externalBook r:id="rId1"><extLst><ext uri="urn:synthetic">${deep}</ext></extLst></externalBook></externalLink>` }), XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await externalLinkPartXlsxSample({ linkXml: `<!DOCTYPE externalLink [<!ENTITY boom "unsafe">]>${prefix}<externalBook r:id="rId1"><extLst><ext uri="urn:synthetic"><x:n>&boom;</x:n></ext></extLst></externalBook></externalLink>` }), XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await externalLinkPartXlsxSample({ linkXml: `${prefix}<externalBook r:id="rId1"><extLst><ext uri="urn:synthetic"><x:script/></ext></extLst></externalBook></externalLink>` }), XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectStructureDetail(await externalLinkPartXlsxSample({ linkXml: `${prefix}<externalBook r:id="rId1"/><externalBook r:id="rId1"/></externalLink>` }), 'external_link_invalid');
});

test('internal relationship targets resolve from package root or source directory without escaping', async () => {
  for (const [root, sheet] of [
    ['/xl/workbook.xml', '/xl/worksheets/sheet1.xml'],
    ['./xl/workbook.xml', './worksheets/sheet1.xml'],
    ['xl/workbook.xml', '../xl/worksheets/sheet1.xml']
  ]) {
    const bytes = await xlsxRelationshipTargetSample(root, sheet);
    assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
    assert.equal(await spooled(bytes, path => verifiedMediaFile(path, bytes.length, XLSX)), XLSX);
  }
  await expectStructureDetail(await xlsxRelationshipTargetSample('/../xl/workbook.xml', 'worksheets/sheet1.xml'), 'relationship_invalid');
  await expectStructureDetail(await xlsxRelationshipTargetSample('xl/workbook.xml', '../../worksheets/sheet1.xml'), 'relationship_invalid');
});

test('an empty DEFLATE directory is valid only when it expands to no bytes', async () => {
  const empty = await xlsxDeflatedDirectorySample();
  assert.equal(await verifiedMedia(empty, XLSX), XLSX);
  assert.equal(await spooled(empty, path => verifiedMediaFile(path, empty.length, XLSX)), XLSX);
  await expectStructureDetail(await xlsxDeflatedDirectorySample(Buffer.from('payload')), 'zip_directory_invalid');
  const badCrc = Buffer.from(empty);
  const eocd = badCrc.length - 22;
  const centralOffset = badCrc.readUInt32LE(eocd + 16);
  const directoryCentral = centralOffset + badCrc.readUInt32LE(eocd + 12) - 46 - Buffer.byteLength('xl/empty/');
  const directoryLocal = badCrc.readUInt32LE(directoryCentral + 42);
  badCrc.writeUInt32LE(1, directoryLocal + 14);
  badCrc.writeUInt32LE(1, directoryCentral + 16);
  await expectStructureDetail(badCrc, 'zip_crc_mismatch');
});

test('only bounded, absolute DOCX http/https/mailto hyperlink relationships are passive', async () => {
  for (const target of ['http://example.invalid/a?x=%B2', 'https://example.invalid/path#section', 'mailto:test@example.invalid', 'mailto:synthetic、name@example.invalid']) {
    const bytes = await externalRelationshipDocxSample(target);
    assert.equal(await verifiedMedia(bytes, DOCX), DOCX);
    assert.equal(await spooled(bytes, path => verifiedMediaFile(path, bytes.length, DOCX)), DOCX);
  }
  for (const [target, type] of [
    ['javascript:alert(1)', 'hyperlink'], ['data:text/html,active', 'hyperlink'],
    ['file:///etc/passwd', 'hyperlink'], ['\\\\server\\share', 'hyperlink'],
    ['../relative', 'hyperlink'], ['https://user:secret@example.invalid', 'hyperlink'],
    ['https://example.invalid/%0a', 'hyperlink'], ['http:\\example.invalid', 'hyperlink'],
    ['https://%65xample.invalid/path', 'hyperlink'], ['mailto:test@example.invalid?subject=active', 'hyperlink'],
    ['https://example.invalid/template', 'attachedTemplate'],
    ['https://example.invalid/asset', 'image']
  ] as const) {
    await expectInspectionFailure(await externalRelationshipDocxSample(target, type), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  }
  await expectInspectionFailure(await externalRelationshipXlsxSample('https://example.invalid'), XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
});

test('passive XLSX workbook links are accepted on both upload inspection paths', async () => {
  const bytes = await externalLinkPartXlsxSample();
  assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
  assert.equal(await spooled(bytes, path => verifiedMediaFile(path, bytes.length, XLSX)), XLSX);
});

test('passive externalBook children and TargetMode casing remain accepted', async () => {
  const linkXml = '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1"><sheetNames><sheetName val="Source"/></sheetNames><definedNames><definedName name="Total" refersTo="Source!A1"/></definedNames><sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1" t="n"><v>42</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>';
  const linkRelsXml = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///synthetic/source.xlsx" TargetMode="external"/></Relationships>';
  const bytes = await externalLinkPartXlsxSample({ linkXml, linkRelsXml });
  assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
  assert.equal(await spooled(bytes, path => verifiedMediaFile(path, bytes.length, XLSX)), XLSX);
});

test('OPC percent-encoded part names are resolved once and unsafe aliases are rejected', async () => {
  const valid = await xlsxPartNameSample('xl/media/report%20image.png');
  assert.equal(await verifiedMedia(valid, XLSX), XLSX);
  assert.equal(await spooled(valid, path => verifiedMediaFile(path, valid.length, XLSX)), XLSX);
  for (const name of ['xl/media/%2e%2e/attack.png', 'xl/media/%252e%252e/attack.png', 'xl/media/image%2fattack.png', 'xl/media/image%5cattack.png', 'xl/media/image%ZZ.png']) {
    await expectInspectionFailure(await xlsxPartNameSample(name), XLSX, name.endsWith('%ZZ.png') ? 422 : 415,
      name.endsWith('%ZZ.png') ? 'MATERIAL_UNREADABLE' : 'MATERIAL_FORMAT_UNSUPPORTED');
  }
});

test('a ZIP end-of-central-directory comment does not make a readable XLSX invalid', async () => {
  const plain = await xlsxSample();
  const comment = Buffer.from('synthetic package comment');
  const bytes = Buffer.concat([plain, comment]);
  assert.equal(plain.readUInt32LE(plain.length - 22), 0x06054b50);
  bytes.writeUInt16LE(comment.length, plain.length - 2);
  assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
  assert.equal(await spooled(bytes, path => verifiedMediaFile(path, bytes.length, XLSX)), XLSX);
});

test('UTF-16 XML with either byte-order mark remains readable', async () => {
  const xml = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>';
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
  const beBody = Buffer.from(xml, 'utf16le').swap16();
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
  for (const sheet of [le, be]) {
    const bytes = await xlsxSample(sheet);
    assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
    assert.equal(await spooled(bytes, path => verifiedMediaFile(path, bytes.length, XLSX)), XLSX);
  }
});

test('structural details distinguish ZIP header mismatch, expanded CRC, and XML parse failures', async () => {
  const localMismatch = Buffer.from(await xlsxSample());
  assert.equal(localMismatch.readUInt32LE(0), 0x04034b50);
  localMismatch.writeUInt32LE(0, 14);
  await expectStructureDetail(localMismatch, 'zip_central_local_mismatch');

  const badCrc = Buffer.from(await xlsxSample());
  const centralOffset = badCrc.readUInt32LE(badCrc.length - 6);
  assert.equal(badCrc.readUInt32LE(centralOffset), 0x02014b50);
  badCrc.writeUInt32LE(0, 14);
  badCrc.writeUInt32LE(0, centralOffset + 16);
  await expectStructureDetail(badCrc, 'zip_crc_mismatch');

  await expectStructureDetail(await xlsxSample(Buffer.from('<worksheet>')), 'xml_parse_error');
});

test('XLSX external links never grant DDE, OLE, macros or malformed XML a path through inspection', async () => {
  const wrapper = (body: string) => `<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${body}</externalLink>`;
  for (const tag of ['ddeLink', 'oleLink']) {
    await expectInspectionFailure(await externalLinkPartXlsxSample({ linkXml: wrapper(`<${tag}/>`)}), XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  }
  await expectInspectionFailure(await externalLinkPartXlsxSample({ extraParts: [{ name: 'xl/vbaProject.bin', contents: Buffer.from('synthetic macro') }] }), XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await externalLinkPartXlsxSample({ linkXml: wrapper('<externalBook r:id="rId1">') }), XLSX, 422, 'MATERIAL_UNREADABLE');
  const unknown = Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>[2]Source!A1</f><v>42</v></c></row></sheetData></worksheet>');
  await expectInspectionFailure(await externalLinkPartXlsxSample({ sheet: unknown }), XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
});

test('Office XML parts remain capped at 16 MiB despite the authorized large document', async () => {
  const body = randomBytes(12 * 1024 * 1024 + 1024).toString('base64');
  const document = Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:t>${body}</w:t></w:p></w:body></w:document>`);
  assert.ok(document.length > 16 * 1024 * 1024);
  const bytes = await docxSample([], document);
  const expected = { status: 415, code: 'MATERIAL_FORMAT_UNSUPPORTED', message: 'Office XML part exceeds the inspection limit' };
  assert.deepEqual(await outcome(verifiedMedia(bytes, DOCX)), expected);
  await assert.rejects(verifiedMedia(bytes, DOCX), (error: unknown) => (error as { uploadReason?: string }).uploadReason === 'xml_part_limit');
  assert.deepEqual(await spooled(bytes, path => outcome(verifiedMediaFile(path, bytes.length, DOCX))), expected);
});

test('Office containers are inspected from the spooled file entry by entry and zip bombs fail closed', async () => {
  // Large, incompressible media parts are streamed through inflate with only a bounded head kept.
  const media = randomBytes(24 * 1024 * 1024);
  const largeDocx = await neutralExtensionDocxSample('application/octet-stream', media);
  const largeXlsx = await xlsxSample(undefined, [{ name: 'xl/media/synthetic.bin', contents: randomBytes(24 * 1024 * 1024) }]);
  assert.equal(await spooled(largeDocx, path => verifiedMediaFile(path, largeDocx.length, DOCX)), DOCX);
  assert.equal(await verifiedMedia(largeDocx, DOCX), DOCX);
  assert.deepEqual(await spooled(largeXlsx, path => outcome(verifiedMediaFile(path, largeXlsx.length, XLSX))), await outcome(verifiedMedia(largeXlsx, XLSX)));

  // A header that under-declares the expanded size is caught while inflating, before the lie can grow.
  const payload = Buffer.concat([randomBytes(64 * 1024), Buffer.alloc(512 * 1024, 0x41)]);
  const honest = await docxSample([{ name: 'word/media/synthetic.bin', contents: payload }]);
  await expectInspectionFailure(lieAboutExpandedSize(honest, 'word/media/synthetic.bin', 128 * 1024), DOCX, 422, 'MATERIAL_UNREADABLE', 'structure_invalid');
  // Per-entry, aggregate and ratio caps come from the central directory, before any part is inflated.
  await expectInspectionFailure(lieAboutExpandedSize(honest, 'word/media/synthetic.bin', 40 * 1024 * 1024), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED', 'archive_expanded_limit');
  const aggregate = await docxSample(Array.from({ length: 5 }, (_, index) => ({ name: `word/media/part-${index}.bin`, contents: Buffer.concat([randomBytes(15 * 1024 * 1024), Buffer.alloc(15 * 1024 * 1024)]) })));
  assert.ok(aggregate.length < 100 * 1024 * 1024, 'aggregate sample stays under the upload limit');
  await expectInspectionFailure(aggregate, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED', 'archive_expanded_limit');
  await expectInspectionFailure(await compressedBombSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED', 'archive_ratio');
  // Truncated spool files (size mismatch with the central directory) are unreadable.
  await spooled(honest, async path => {
    await assert.rejects(verifiedMediaFile(path, honest.length - 1, DOCX), (error: unknown) => (error as { code: string }).code === 'MATERIAL_UNREADABLE');
  });
});

test('upload inspection rejects encryption, corrupt structures, active content, and bounded archive abuse', async () => {
  const encryptedPdf = pdfSample({ encrypted: true });
  const scriptPdf = pdfSample({ javascript: true });
  const corruptPdf = pdfSample({ corrupt: true });
  const corruptDocx = (await docxSample()).subarray(0, -10);
  const corruptXlsx = (await xlsxSample()).subarray(0, -10);
  const neutralSvgPart = await neutralExtensionDocxSample('image/svg+xml', Buffer.from('<svg><script>alert(1)</script></svg>'));
  const neutralParameterizedSvgPart = await neutralExtensionDocxSample('Image/SVG+XML ; charset=utf-8', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  const neutralHtmlPart = await neutralExtensionDocxSample('Text/HTML; charset=utf-8', Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>'));
  const neutralMhtmlPart = await neutralExtensionDocxSample('multipart/related; boundary=synthetic', Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=synthetic\r\n\r\n--synthetic\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>'));
  const neutralTypedSvgPart = await neutralExtensionDocxSample('application/octet-stream', Buffer.from('<?xml version="1.0"?><!-- synthetic active image --><svg><script>alert(1)</script></svg>'));
  const neutralUtf16SvgPart = await neutralExtensionDocxSample('application/octet-stream', Buffer.from('<svg><script>alert(1)</script></svg>', 'utf16le'));
  const paddedNeutralSvgPart = await neutralExtensionDocxSample('application/octet-stream', Buffer.concat([Buffer.from('<!-- synthetic prefix -->'), Buffer.alloc(9 * 1024, 0x20), Buffer.from('<svg><script>alert(1)</script></svg>')]));
  const neutralTypedHtmlPart = await neutralExtensionDocxSample('application/octet-stream', Buffer.from('<!doctype html><html><script>alert(1)</script></html>'));
  const neutralTypedMhtmlPart = await neutralExtensionDocxSample('application/octet-stream', Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=synthetic\r\n\r\n--synthetic\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>'));
  const activeXlsx = await xlsxSample(Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><f>WEBSERVICE("https://example.invalid")</f></c></row></sheetData></worksheet>'));
  const imageFormulaXlsx = await xlsxSample(Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><f>IMAGE("https://example.invalid/image.png")</f></c></row></sheetData></worksheet>'));
  const nestedDocx = await docxSample([{ name: 'word/embeddings/inner.zip', contents: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }]);
  const unicodeWhitespaceFormulaCsv = Buffer.from(`name,value\nrow,"${'\u00a0'.repeat(600)}=HYPERLINK(""https://example.invalid"")"\n`);
  const bomFormulaCsv = Buffer.from('\uFEFF"=HYPERLINK(""https://example.invalid"")"\n');
  const badPng = pngSample.subarray(0, -8);
  const badJpeg = jpegSample.subarray(0, -8);

  await expectInspectionFailure(encryptedPdf, PDF, 422, 'MATERIAL_ENCRYPTED', 'encrypted_content');
  await expectInspectionFailure(encryptedOfficeSample(), DOCX, 422, 'MATERIAL_ENCRYPTED');
  await expectInspectionFailure(await encryptedZipSample(), DOCX, 422, 'MATERIAL_ENCRYPTED');
  await expectInspectionFailure(corruptPdf, PDF, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(corruptDocx, DOCX, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(corruptXlsx, XLSX, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(Buffer.from('ordinary text'), PDF, 422, 'MATERIAL_CONTENT_MISMATCH');
  await expectInspectionFailure(scriptPdf, PDF, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await pptxSample(), PPTX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await pptxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await activeDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await activeSvgDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(neutralSvgPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(neutralParameterizedSvgPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(neutralHtmlPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(neutralMhtmlPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(neutralTypedSvgPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(neutralUtf16SvgPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(paddedNeutralSvgPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(neutralTypedHtmlPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(neutralTypedMhtmlPart, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await macroDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await macroDefaultDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(activeXlsx, XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(imageFormulaXlsx, XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(nestedDocx, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await nestedGzipDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await compressedBombSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await expandedSizeBombSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED', 'archive_expanded_limit');
  await expectInspectionFailure(await entryCountBombSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED', 'archive_entry_limit');
  await expectInspectionFailure(csvFormulaSample, CSV, 415, 'MATERIAL_FORMAT_UNSUPPORTED', 'unsupported_content');
  await expectInspectionFailure(unicodeWhitespaceFormulaCsv, CSV, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(bomFormulaCsv, CSV, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(Buffer.from('column,value\nrow,"unterminated', 'utf8'), CSV, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(badPng, PNG, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(badJpeg, JPEG, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(Buffer.from([0xc3, 0x28]), TEXT, 422, 'MATERIAL_CONTENT_MISMATCH', 'content_mismatch');
});

test('inspection infrastructure and size rejections expose fixed internal reasons', async () => {
  await assert.rejects(verifiedMedia(Buffer.alloc(0), TEXT), (error: unknown) => (error as { uploadReason?: string }).uploadReason === 'size_limit');
  await assert.rejects(verifiedMediaFile('/no-such-material-upload', 1, XLSX), (error: unknown) => (error as { uploadReason?: string }).uploadReason === 'inspection_worker_failed');
  await assert.rejects(runInspectionWorker({ bytes: Uint8Array.from(textSample).buffer, mediaType: TEXT }, [], TEXT, 32, 1),
    (error: unknown) => (error as { reason?: string }).reason === 'inspection_timeout');
});

test('upload inspection is single-flight: extra work queues, and a bounded wait fails with a stable 503', async () => {
  // Queued inspections run one after another and all succeed.
  assert.deepEqual(await Promise.all([verifiedMedia(textSample, TEXT), verifiedMedia(textSample, TEXT), verifiedMedia(textSample, TEXT)]), [TEXT, TEXT, TEXT]);
  process.env.BB_UPLOAD_INSPECTION_QUEUE_MS = '1';
  try {
    const first = verifiedMedia(textSample, TEXT);
    const rejected = verifiedMedia(textSample, TEXT);
    await assert.rejects(rejected, (error: unknown) => {
      assert.equal((error as Error & { status: number }).status, 503);
      assert.equal((error as Error & { code: string }).code, 'DATA_UNAVAILABLE');
      assert.equal((error as Error & { uploadReason: string }).uploadReason, 'inspection_queue_timeout');
      return true;
    });
    assert.equal(await first, TEXT);
  } finally {
    delete process.env.BB_UPLOAD_INSPECTION_QUEUE_MS;
  }
  assert.equal(await verifiedMedia(textSample, TEXT), TEXT, 'capacity is released after use');
});

test('PostgreSQL/Azurite upload scan runs before Blob receipt and preserves owner 404 and retry idempotency', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const originalOwnerId = `upload-${randomUUID()}`;
  let ownerId = originalOwnerId;
  const containerName = `bb-upload-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, containerName);
  const app = createServer({
    pool,
    blobs,
    principal: async () => ({ userId: ownerId, csrfVerified: true }),
    allowedOrigin: origin
  });
  const send = (method: string, url: string, payload?: unknown, contentType = 'application/json') => app.inject({
    method: method as any,
    url,
    headers: { origin, 'content-type': contentType },
    payload: payload as any
  });
  let projectId = '';
  try {
    await pool.query('SELECT 1');
    const project = await send('POST', '/api/v1/projects', { name: 'Synthetic Upload Safety', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(project.statusCode, 201, project.body);
    projectId = project.json().project_id;
    const pdf = pdfSample();
    const start = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      filename: 'synthetic.pdf', media_type: PDF, byte_size: pdf.length, sha256: digest(pdf), role: 'audit'
    });
    assert.equal(start.statusCode, 201, start.body);
    const uploadUrl = start.json().upload_url;
    const uploadId = start.json().upload_id;
    const firstPut = await send('PUT', uploadUrl, pdf, 'application/octet-stream');
    assert.equal(firstPut.statusCode, 204, firstPut.body);
    assert.equal((await send('PUT', uploadUrl, pdf, 'application/octet-stream')).statusCode, 204, 'retrying received bytes stays idempotent');
    const completeUrl = `/api/v1/projects/${projectId}/materials/uploads/${uploadId}/complete`;
    const complete = await send('POST', completeUrl, { byte_size: pdf.length, sha256: digest(pdf) });
    assert.equal(complete.statusCode, 200, complete.body);
    const replay = await send('POST', completeUrl, { byte_size: pdf.length, sha256: digest(pdf) });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().material_id, complete.json().material_id);

    const bad = await docxSample();
    bad.writeUInt32LE(0, bad.length - 22); // Corrupt the end-of-central-directory signature while keeping the request structurally plausible.
    const rejectedStart = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      filename: 'corrupt.docx', media_type: DOCX,
      byte_size: bad.length, sha256: digest(bad), role: 'audit'
    });
    assert.equal(rejectedStart.statusCode, 201, rejectedStart.body);
    const rejectedPut = await send('PUT', rejectedStart.json().upload_url, bad, 'application/octet-stream');
    assert.equal(rejectedPut.statusCode, 422, rejectedPut.body);
    assert.equal(rejectedPut.json().code, 'MATERIAL_UNREADABLE');
    assert.equal(rejectedPut.json().reason, undefined);
    assert.equal(rejectedPut.json().detail, undefined);
    const rejection = await pool.query("SELECT event FROM bb_observability_events WHERE kind='operation.rejected' AND event->>'request_id'=$1", [rejectedPut.json().correlation_id]);
    assert.equal(rejection.rowCount, 1);
    assert.equal(rejection.rows[0].event.error.reason, 'structure_invalid');
    assert.equal(rejection.rows[0].event.error.detail, 'zip_eocd_missing');
    assert.equal(rejection.rows[0].event.error.error_id, rejectedPut.json().correlation_id);
    const blobKey = `users/${ownerId}/projects/${projectId}/uploads/${rejectedStart.json().upload_id}`;
    assert.equal(await blobs.getIfExists(blobKey), null, 'rejected bytes never reach private Blob storage');

    ownerId = `upload-other-${randomUUID()}`;
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${complete.json().material_id}`)).statusCode, 404);
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${complete.json().material_id}/download`)).statusCode, 404);
  } finally {
    if (projectId) {
      // The completed material now has a retained parse job and append-only #79 operation rows,
      // so its synthetic owner/project rows stay; suites that need a clean slate TRUNCATE ... CASCADE.
      await pool.query('DELETE FROM bb_outbox WHERE owner_user_id=$1', [originalOwnerId]);
    }
    await app.close();
    await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(containerName).deleteIfExists();
  }
});
