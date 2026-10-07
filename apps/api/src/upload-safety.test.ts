import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { digest, Problem } from './data.js';
import { configuredUploadInspectionException, uploadInspectionExceptionMatches } from './upload-inspection-exception.js';
import { inspectMaterialUpload, inspectMaterialUploadFile, inspectMaterialUploadFileDetailed, UploadSafetyError, inspectMaterialUploadDetailed, runInspectionWorker } from './upload-safety.js';
import { MAX_SIGNED_PDF_BYTES, SignedPdfProfileError, validateSignedPdfProfile } from './signed-pdf-profile.js';
import { multipageSignedPdf } from './signed-pdf-multipage.samples.js';
import {
  activeDocxSample, activeSvgDocxSample, compressedBombSample, csvFormulaSample, csvSample, DOCX, docxSample,
  encryptedOfficeSample, encryptedZipSample, entryCountBombSample, expandedSizeBombSample, externalLinkPartXlsxSample, externalRelationshipDocxSample, externalRelationshipXlsxSample, JPEG, jpegSample, CSV,
  macroDefaultDocxSample, macroDocxSample, neutralExtensionDocxSample, nestedGzipDocxSample, PDF, pdfSample, PNG, pngSample, PPTX, pptxSample, TEXT, textSample,
  XLSX, xlsxSample, xlsxPartNameSample, xlsxRelationshipTargetSample, xlsxDeflatedDirectorySample, pdfWidgetSample
} from './upload-safety.samples.js';

// These are legacy content-tool tests, not the project's raw-upload admission policy.
const legacy = async <T>(work: Promise<T>): Promise<T> => {
  try { return await work; } catch (error) {
    if (error instanceof UploadSafetyError) throw new Problem(error.status,error.code,error.message,error.reason,error.detail);
    throw new Problem(422,'MATERIAL_UNREADABLE','Legacy inspection failed','inspection_worker_failed');
  }
};
const verifiedMedia = (bytes:Buffer,type:string) => legacy(inspectMaterialUpload(bytes,type));
const verifiedMediaFile = (path:string,size:number,type:string) => legacy(inspectMaterialUploadFile(path,size,type));
const verifiedMediaFileDetailed = (path:string,size:number,type:string) => legacy(inspectMaterialUploadFileDetailed(path,size,type));


test('upload inspection exception requires preprod, an explicit switch and one exact XLSX identity', () => {
  const scopeText = `owner-a:project-a:audit:411637:${'a'.repeat(64)}`;
  assert.equal(configuredUploadInspectionException({ BB_DEPLOYMENT_TIER: 'preprod', BB_UPLOAD_EXCEPTION_SCOPE: scopeText }), null);
  assert.throws(() => configuredUploadInspectionException({ BB_DEPLOYMENT_TIER: 'production', BB_UPLOAD_EXCEPTION_ENABLED: '1', BB_UPLOAD_EXCEPTION_SCOPE: scopeText }));
  assert.throws(() => configuredUploadInspectionException({ BB_DEPLOYMENT_TIER: 'preprod', BB_UPLOAD_EXCEPTION_ENABLED: '1', BB_UPLOAD_EXCEPTION_SCOPE: 'invalid' }));
  const scope = configuredUploadInspectionException({ BB_DEPLOYMENT_TIER: 'preprod', BB_UPLOAD_EXCEPTION_ENABLED: '1', BB_UPLOAD_EXCEPTION_SCOPE: scopeText });
  const candidate = { ownerUserId: 'owner-a', projectId: 'project-a', role: 'audit', byteSize: 411637, sha256: 'a'.repeat(64), mediaType: XLSX };
  assert.equal(uploadInspectionExceptionMatches(scope, candidate), true);
  for (const changed of [{ ownerUserId: 'owner-b' }, { projectId: 'project-b' }, { role: 'notes' }, { byteSize: 411636 }, { sha256: 'b'.repeat(64) }, { mediaType: DOCX }]) {
    assert.equal(uploadInspectionExceptionMatches(scope, { ...candidate, ...changed }), false);
  }
});

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
  assert.equal(await verifiedMedia(await externalLinkPartXlsxSample({ linkXml: `${prefix}<externalBook r:id="rId1"/><externalBook r:id="rId1"/></externalLink>` }), XLSX), XLSX);
});

test('passive XLSX alternate URLs and multiple external link paths are accepted without resolving targets', async () => {
  const linkXml = '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1"><alternateUrls><alternateUrl r:id="rId2"/></alternateUrls><relativeUrl r:id="rId2"/></externalBook></externalLink>';
  const linkRelsXml = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///synthetic/source.xlsx" TargetMode="External"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="https://example.invalid/alternate.xlsx" TargetMode="External"/></Relationships>';
  const bytes = await externalLinkPartXlsxSample({ linkXml, linkRelsXml });
  assert.equal(await verifiedMedia(bytes, XLSX), XLSX);
  assert.equal(await spooled(bytes, path => verifiedMediaFile(path, bytes.length, XLSX)), XLSX);
  const activeRels = linkRelsXml.replace('relationships/externalLinkPath" Target="https:', 'relationships/oleObject" Target="https:');
  await expectInspectionFailure(await externalLinkPartXlsxSample({ linkXml, linkRelsXml: activeRels }), XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
});

const externalLinkPrefix = '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
const alternateBook = '<mc:AlternateContent><mc:Choice Requires="x"><externalBook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" r:id="rId1"/></mc:Choice></mc:AlternateContent>';
const wrongRootNamespace = `<x:externalLink xmlns:x="urn:unrelated" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${alternateBook}</x:externalLink>`;
const missingRootNamespace = `<externalLink xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${alternateBook}</externalLink>`;

async function invalidPassiveLinkSamples(): Promise<Array<{ name: string; bytes: Buffer }>> {
  return [
    { name: 'empty link', bytes: await externalLinkPartXlsxSample({ linkXml: `${externalLinkPrefix}</externalLink>` }) },
    { name: 'missing relationships part', bytes: await externalLinkPartXlsxSample({ omitLinkRels: true }) },
    { name: 'dangling externalBook id', bytes: await externalLinkPartXlsxSample({ linkXml: `${externalLinkPrefix}<externalBook r:id="missing"/></externalLink>` }) },
    { name: 'dangling alternateUrl id', bytes: await externalLinkPartXlsxSample({ linkXml: `${externalLinkPrefix}<externalBook r:id="rId1"><alternateUrls><alternateUrl r:id="missing"/></alternateUrls></externalBook></externalLink>` }) },
    { name: 'dangling relativeUrl id', bytes: await externalLinkPartXlsxSample({ linkXml: `${externalLinkPrefix}<externalBook r:id="rId1"><alternateUrls><relativeUrl r:id="missing"/></alternateUrls></externalBook></externalLink>` }) },
    { name: 'wrong root namespace with compatible choice', bytes: await externalLinkPartXlsxSample({ linkXml: wrongRootNamespace }) },
    { name: 'missing root namespace with compatible choice', bytes: await externalLinkPartXlsxSample({ linkXml: missingRootNamespace }) },
  ];
}

test('XLSX external workbook parts require a book, its relationships part and every referenced passive path', async () => {
  for (const { name, bytes } of await invalidPassiveLinkSamples()) {
    await expectStructureDetail(bytes, 'external_link_invalid');
  }
  const alias = '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook rel:id="rId1"/></externalLink>';
  assert.equal(await verifiedMedia(await externalLinkPartXlsxSample({ linkXml: alias }), XLSX), XLSX);
  const prefixedRoot = '<s:externalLink xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><s:externalBook r:id="rId1"/></s:externalLink>';
  assert.equal(await verifiedMedia(await externalLinkPartXlsxSample({ linkXml: prefixedRoot }), XLSX), XLSX);
  assert.equal(await verifiedMedia(await externalLinkPartXlsxSample(), XLSX), XLSX);
  const wrongNamespace = '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="urn:unrelated"><externalBook r:id="rId1"/></externalLink>';
  await expectStructureDetail(await externalLinkPartXlsxSample({ linkXml: wrongNamespace }), 'external_link_invalid');
  const duplicateAliases = '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1" rel:id="rId1"/></externalLink>';
  await expectStructureDetail(await externalLinkPartXlsxSample({ linkXml: duplicateAliases }), 'external_link_invalid');
  const duplicateRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///synthetic/a.xlsx" TargetMode="External"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///synthetic/b.xlsx" TargetMode="External"/></Relationships>';
  await expectStructureDetail(await externalLinkPartXlsxSample({ linkRelsXml: duplicateRels }), 'external_link_invalid');
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
  for (const tag of ['ddeLink', 'oleLink', 'oleObject', 'iframe']) {
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

test('PDF upload admits only the restricted filled Sig fixture and rejects other Widgets', async () => {
  // The placeholder /Contents is not CMS data and makes no validity claim.
  const populatedSigOnly = pdfWidgetSample({ fieldType: 'Sig', populated: true });
  const blankSig = pdfWidgetSample({ fieldType: 'Sig', populated: false });
  const populatedTextWidget = pdfWidgetSample({ fieldType: 'Tx', populated: true });
  const pdfjs = await import(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    AnnotationType: { WIDGET: number };
    getDocument(source: Record<string, unknown>): {
      promise: Promise<{
        getPage(pageNumber: number): Promise<{
          getAnnotations(options: { intent: string }): Promise<Array<{ annotationType?: number; fieldType?: string; fieldValue?: unknown }>>;
        }>;
      }>;
      destroy(): Promise<void>;
    };
  };

  for (const [name, bytes, expectedFieldType, expectedFieldValue] of [
    ['blank Sig Widget', blankSig, 'Sig', null],
    ['non-Sig text Widget', populatedTextWidget, 'Tx', 'Synthetic text'],
  ] as const) {
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, stopAtErrors: true });
    try {
      const document = await loading.promise;
      const annotations = await (await document.getPage(1)).getAnnotations({ intent: 'display' });
      const widget = annotations.find(annotation => annotation.annotationType === pdfjs.AnnotationType.WIDGET);
      assert.ok(widget, `${name} must be parsed by PDF.js as a Widget annotation`);
      assert.equal(widget.fieldType, expectedFieldType, `${name} retains its PDF field type`);
      assert.equal(widget.fieldValue, expectedFieldValue, `${name} retains the PDF.js-exposed field value`);
    } finally {
      await loading.destroy();
    }
    await expectInspectionFailure(bytes, PDF, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
    await assert.rejects(verifiedMedia(bytes, PDF), (error: unknown) => {
      const failure = error as { status?: number; code?: string };
      return failure.status === 415 && failure.code === 'MATERIAL_FORMAT_UNSUPPORTED';
    }, `${name} must never be accepted by upload inspection`);
  }
  const expected = { mediaType: PDF, signatureAssessment: { status: 'signature_unverified', profile_version: 'signed-pdf-classic-v1', signature_count: 1 } };
  assert.deepEqual(await inspectMaterialUploadDetailed(populatedSigOnly, PDF), expected);
  assert.deepEqual(await spooled(populatedSigOnly, path => verifiedMediaFileDetailed(path, populatedSigOnly.length, PDF)), expected);
  assert.equal(digest(populatedSigOnly), createHash('sha256').update(populatedSigOnly).digest('hex'));
  assert.match(populatedSigOnly.toString('ascii'), /\/V << \/Type \/Sig /,
    'the populated Sig fixture has a value dictionary, without claiming its CMS validity');
});

test('signed PDF risk controls remain fail-closed on both inspection paths', async () => {
  const sig = (contents: string, range = '[0 0000000000 0000000000 0000000000]') =>
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange ${range} /Contents ${contents} >>`;
  const cases: Array<[string, Buffer]> = [
    ['empty signature value', pdfWidgetSample({ signatureValue: 'null' })],
    ['missing byte range', pdfWidgetSample({ signatureValue: '<< /Type /Sig /Contents <01> >>' })],
    ['overlapping byte range', pdfWidgetSample({ signatureValue: sig('<01>', '[0 10 9 10]') })],
    ['out-of-bounds byte range', pdfWidgetSample({ signatureValue: sig('<01>', '[0 10 9999999999 10]') })],
    ['empty contents', pdfWidgetSample({ signatureValue: sig('<>') })],
    ['zero-filled contents', Buffer.from(pdfWidgetSample().toString('ascii').replace('/Contents <01>', '/Contents <00>'), 'ascii')],
    ['non-hex contents', pdfWidgetSample({ signatureValue: sig('<GG>') })],
    ['incremental revision after signature', pdfWidgetSample({ appendRevision: true })],
    ['choice widget', pdfWidgetSample({ fieldType: 'Ch' })],
    ['button widget', pdfWidgetSample({ fieldType: 'Btn' })],
    ['document JavaScript action', pdfWidgetSample({ catalogExtra: '/OpenAction << /S /JavaScript /JS (app.alert\(1\)) >>' })],
    ['annotation additional action', pdfWidgetSample({ widgetExtra: '/AA << /U << /S /JavaScript /JS (app.alert\(1\)) >> >>' })],
    ['XFA', pdfWidgetSample({ catalogExtra: '/XFA (synthetic)' })],
    ['embedded files', pdfWidgetSample({ catalogExtra: '/Names << /EmbeddedFiles << /Names [] >> >>' })],
    ['RichMedia', pdfWidgetSample({ widgetExtra: '/RichMedia << >>' })],
    ['external action', pdfWidgetSample({ pageExtra: '/AA << /O << /S /URI /URI (https://example.invalid) >> >>' })],
    ['duplicate field key', pdfWidgetSample({ widgetExtra: '/FT /Sig' })],
    ['escaped active name', pdfWidgetSample({ widgetExtra: '/J#53 (synthetic)' })],
    ['hidden indexed object', pdfWidgetSample({ extraObject: '<< /Type /Action /S /JavaScript >>' })],
    ['recursive appearance resource', pdfWidgetSample({ appearanceResources: '<< /XObject << /Self 6 0 R >> >>' })]
  ];
  for (const [name, bytes] of cases) {
    await expectInspectionFailure(bytes, PDF, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
    assert.ok(bytes.length < 10_000, `${name} is a small synthetic control`);
  }
  assert.throws(() => validateSignedPdfProfile(Buffer.alloc(MAX_SIGNED_PDF_BYTES + 1)), SignedPdfProfileError, 'restricted profile has a bounded byte budget');
});

test('multipage signatures retain bytes and reject active, ambiguous or incomplete inputs', async () => {
  const valid = multipageSignedPdf();
  assert.deepEqual(await inspectMaterialUploadDetailed(valid,PDF), {
    mediaType:PDF,signatureAssessment:{status:'signature_unverified',profile_version:'signed-pdf-multipage-v2',signature_count:1}
  });
  for (const bytes of [
    multipageSignedPdf({catalog:'/OpenAction << /S /JavaScript /JS (synthetic) >>'}),
    multipageSignedPdf({widget:'/J#53 (synthetic)'}),
    multipageSignedPdf({widget:'/F#54 /Sig'}),
    multipageSignedPdf({widget:'/V null'}),
    multipageSignedPdf({fieldType:'Tx'}),
    multipageSignedPdf({hidden:'<< /S /Launch >>'}),
    multipageSignedPdf({catalog:'/XFA (synthetic)'}),
    multipageSignedPdf({catalog:'/Names << /EmbeddedFiles << /Names [] >> >>'}),
    multipageSignedPdf({recursiveAppearance:true}),
    multipageSignedPdf({unsignedRevision:true}),
    Buffer.from(valid.toString('ascii').replace('<01>','<00>'),'ascii'),
    Buffer.from(valid.toString('ascii').replace('/ByteRange [0 ','/ByteRange [1 '),'ascii')
  ]) {
    await assert.rejects(inspectMaterialUploadDetailed(bytes,PDF), (error: unknown) => [415,422].includes((error as {status:number}).status));
  }
});

test('authorized qx signed PDF is accepted unchanged by the multipage profile', async () => {
  const sampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tests/samples/2026-09-25');
  const manifest = JSON.parse(await readFile(join(sampleRoot, 'manifest.json'), 'utf8')) as {
    cases: Array<{ case_id: string; files: Array<{ file_id: string; path: string; bytes: number; sha256: string }> }>;
  };
  const entry = manifest.cases.find(item => item.case_id === 'qx-202606')?.files.find(item => item.file_id === 'qx-202606-02');
  assert.ok(entry);
  assert.equal(entry.sha256, 'f6ab6dae2d70f09390915ea9d3eeb7a755df51d3307f1eb204ae1243ed971844');
  const path = join(sampleRoot, entry.path);
  const bytes = await readFile(path);
  assert.equal(bytes.length, entry.bytes);
  assert.equal(digest(bytes), entry.sha256);
  const result = await verifiedMediaFileDetailed(path, bytes.length, PDF);
  assert.deepEqual(result.signatureAssessment, {status:'signature_unverified',profile_version:'signed-pdf-multipage-v2',signature_count:4});
  assert.equal(digest(await readFile(path)), entry.sha256);
  assert.throws(() => validateSignedPdfProfile(bytes), SignedPdfProfileError);
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
