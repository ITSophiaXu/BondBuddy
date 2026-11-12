import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {makeWorkerDocxFixture} from '../../worker/src/docx-test-fixture.js';
import {xlsxSample} from '../../api/src/upload-safety.samples.js';

// Generated engineering fixtures only: no customer documents, account credentials,
// real issuer facts, provider calls or payment activity. Creating them starts no task.
export const LOCAL_PRELAUNCH_SOURCE_PERIOD = '2025-12-31';
export const LOCAL_PRELAUNCH_TARGET_PERIOD = '2026-09-30';
export const LOCAL_PRELAUNCH_SYNTHETIC_PDF_PASSWORD = 'synthetic-local-prelaunch-password';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = 'application/pdf';

export type LocalPrelaunchBasicFixtureId =
  | 'normalDocx' | 'zeroByteDocx' | 'unsupportedExecutable' | 'docxNamedPdf'
  | 'damagedDocx' | 'truncatedDocx' | 'emptyDocx' | 'normalPdf' | 'corruptPdf';
export type LocalPrelaunchOriginalFixtureId = LocalPrelaunchBasicFixtureId | 'encryptedPdf';
export type LocalPrelaunchFinancialFixtureId = 'normalXlsx' | 'damagedXlsx' | 'truncatedXlsx';
export type LocalPrelaunchFixtureId = LocalPrelaunchOriginalFixtureId | LocalPrelaunchFinancialFixtureId;
export type LocalPrelaunchFixture = Readonly<{
  id: LocalPrelaunchFixtureId;
  name: string;
  mimeType: string;
  buffer: Buffer;
  sha256: string;
  actualFormat: 'docx' | 'pdf' | 'xlsx' | 'empty' | 'unsupported-bytes' | 'damaged-docx' | 'truncated-docx' | 'corrupt-pdf' | 'damaged-xlsx' | 'truncated-xlsx';
  note: string;
  // Parser expectations are diagnostic hints, never raw-upload admission claims.
  expectedParserCodes?: readonly string[];
}>;
export type LocalPrelaunchBasicFixtures = Record<LocalPrelaunchBasicFixtureId, LocalPrelaunchFixture>;
export type LocalPrelaunchFixtures = Record<LocalPrelaunchOriginalFixtureId, LocalPrelaunchFixture>;
export type LocalPrelaunchFinancialFixtures = Record<LocalPrelaunchFinancialFixtureId, LocalPrelaunchFixture>;
export type LocalPrelaunchFixtureOptions = Readonly<{marker?: string}>;

function markerFor(options: LocalPrelaunchFixtureOptions): string {
  const marker = options.marker ?? 'bb-local-prelaunch-20261107';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(marker))
    throw new Error('Synthetic fixture marker must be a 1–64 character ASCII identifier.');
  return marker;
}

export function localPrelaunchIssuerName(options: LocalPrelaunchFixtureOptions = {}): string {
  return `合成${markerFor(options)}发行人有限公司`;
}

function fixture(id: LocalPrelaunchFixtureId, name: string, mimeType: string, buffer: Buffer,
  actualFormat: LocalPrelaunchFixture['actualFormat'], note: string,
  expectedParserCodes?: readonly string[]): LocalPrelaunchFixture {
  const bytes = Buffer.from(buffer);
  return {id, name, mimeType, buffer: bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
    actualFormat, note, ...(expectedParserCodes ? {expectedParserCodes} : {})};
}

/** A small, valid PDF with actual extractable text, unlike pdfSample()'s blank page. */
function textPdf(marker: string): Buffer {
  const lines = [
    'SYNTHETIC LOCAL PRELAUNCH TEST DOCUMENT - NOT CUSTOMER DATA',
    `Issuer marker: ${marker}`,
    'Original reporting period: 2025 annual / 2025-12-31',
    'No real financial figures, bond issuance or investment advice.'
  ];
  const content = lines.map((line, index) =>
    `BT /F1 10 Tf 40 ${750 - index * 22} Td (${line}) Tj ET`).join('\n') + '\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let document = '%PDF-1.4\n% synthetic local-prelaunch fixture\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, 'ascii'));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document, 'ascii');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, 'ascii');
}

/** Synchronous fixtures; all bytes stay in memory unless the caller explicitly saves them. */
export function createLocalPrelaunchBasicFixtures(options: LocalPrelaunchFixtureOptions = {}): LocalPrelaunchBasicFixtures {
  const marker = markerFor(options), issuer = localPrelaunchIssuerName(options);
  const sourceText = `【纯合成测试文件 / SYNTHETIC】${issuer}历史募集说明书。原稿报告期：2025年度（2025年12月31日）。`
    + `唯一测试标记：${marker}。本文件不含真实企业、财务数据、发行安排或客户材料；所有缺失事实待人工提供，不得填零或编造。`;
  const normalDocx = makeWorkerDocxFixture({externalLink: false, text: sourceText});
  const emptyDocx = makeWorkerDocxFixture({externalLink: false, text: ''});
  return {
    normalDocx: fixture('normalDocx', `${marker}-合成2025年度原稿.docx`, DOCX, normalDocx, 'docx',
      'Valid synthetic OOXML with an explicit declaration, unique issuer and original reporting period.'),
    zeroByteDocx: fixture('zeroByteDocx', `${marker}-零字节.docx`, DOCX, Buffer.alloc(0), 'empty',
      'Zero-byte upload-size negative; contains no document package.'),
    unsupportedExecutable: fixture('unsupportedExecutable', `${marker}-不支持文件.exe`, 'application/x-executable',
      Buffer.from(`SYNTHETIC unsupported MIME fixture ${marker}; inert plain text, not executable code.\n`),
      'unsupported-bytes', 'Unsupported MIME/extension negative. These inert bytes are not an executable.'),
    docxNamedPdf: fixture('docxNamedPdf', `${marker}-伪PDF扩展.pdf`, PDF, normalDocx, 'docx',
      'Actual DOCX bytes declared as PDF. Raw storage may accept the declaration; parsing must not fabricate PDF success.', ['MATERIAL_UNREADABLE']),
    damagedDocx: fixture('damagedDocx', `${marker}-损坏结构.docx`, DOCX,
      Buffer.from(`PK synthetic but not a valid Office archive ${marker}`), 'damaged-docx',
      'Deliberately invalid Office archive, adapted from the native parser negative.', ['MATERIAL_UNREADABLE']),
    truncatedDocx: fixture('truncatedDocx', `${marker}-截断原稿.docx`, DOCX, normalDocx.subarray(0, -10),
      'truncated-docx', 'Valid synthetic DOCX with ten ZIP trailer bytes removed.', ['MATERIAL_UNREADABLE']),
    emptyDocx: fixture('emptyDocx', `${marker}-无文字内容.docx`, DOCX, emptyDocx, 'docx',
      'Valid OOXML containing no native text. Distinct from zero bytes; blank-file handling depends on the consuming task.', ['MATERIAL_UNREADABLE']),
    normalPdf: fixture('normalPdf', `${marker}-合成2025年度材料.pdf`, PDF, textPdf(marker), 'pdf',
      'Valid single-page PDF with actual extractable ASCII synthetic text; no OCR or financial facts needed.'),
    corruptPdf: fixture('corruptPdf', `${marker}-损坏PDF.pdf`, PDF,
      Buffer.from('%PDF-1.4\ncorrupt structure\n%%EOF\n', 'ascii'), 'corrupt-pdf',
      'Exact malformed bytes from upload-safety.samples.ts pdfSample({corrupt:true}); no contracts build needed.', ['MATERIAL_UNREADABLE'])
  };
}

const encryptPdfSource = `
import base64, io, json, sys
from pypdf import PdfReader, PdfWriter
payload = json.load(sys.stdin)
source = PdfReader(io.BytesIO(base64.b64decode(payload['pdf'])))
writer = PdfWriter()
for page in source.pages:
    writer.add_page(page)
writer.add_metadata({'/Title': 'SYNTHETIC local-prelaunch encrypted PDF', '/Subject': payload['marker']})
writer.encrypt(payload['password'], algorithm='RC4-128')
output = io.BytesIO()
writer.write(output)
data = output.getvalue()
check = PdfReader(io.BytesIO(data))
assert check.is_encrypted, 'fixture was not encrypted'
assert check.decrypt('') == 0, 'empty password unexpectedly opens the fixture'
assert check.decrypt(payload['password']) != 0, 'synthetic password cannot open the fixture'
assert payload['marker'] in ''.join(page.extract_text() or '' for page in check.pages), 'encrypted source text changed'
sys.stdout.buffer.write(data)
`;

/** Requires the caller's explicit local Python executable with pypdf installed; no shell or files. */
export async function createLocalPrelaunchFixtures(options: LocalPrelaunchFixtureOptions & {pythonExecutable: string}): Promise<LocalPrelaunchFixtures> {
  if (!options.pythonExecutable.trim()) throw new Error('A local Python executable with pypdf is required for the encrypted fixture.');
  const basic = createLocalPrelaunchBasicFixtures(options), marker = markerFor(options);
  const encrypted = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(options.pythonExecutable, ['-c', encryptPdfSource],
      {encoding: 'buffer', timeout: 30_000, maxBuffer: 4 * 1024 * 1024}, (error, stdout, stderr) => {
        if (error) {reject(new Error(`Synthetic encrypted PDF generation failed: ${stderr.toString().slice(0, 1200)}`, {cause: error})); return;}
        resolve(Buffer.from(stdout));
      });
    child.stdin?.on('error', reject);
    child.stdin?.end(JSON.stringify({pdf: basic.normalPdf.buffer.toString('base64'), marker,
      password: LOCAL_PRELAUNCH_SYNTHETIC_PDF_PASSWORD}));
  });
  return {...basic, encryptedPdf: fixture('encryptedPdf', `${marker}-密码加密PDF.pdf`, PDF, encrypted, 'pdf',
    'Real pypdf password encryption, verified encrypted, empty-password refusal and source-text recovery in the child process.', ['MATERIAL_ENCRYPTED'])};
}

/** Native workbook with explicitly invented financial values, followed by two invalid ZIP variants. */
export async function createLocalPrelaunchFinancialFixtures(options: LocalPrelaunchFixtureOptions = {}): Promise<LocalPrelaunchFinancialFixtures> {
  const marker = markerFor(options), media = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const strings = [
    ['A1', `SYNTHETIC FINANCIAL WORKBOOK ${marker} - NOT REAL FINANCIAL INFORMATION`],
    ['A2', '所有数字均为工程测试虚构示例，不属于任何真实发行人。'],
    ['A3', '项目'], ['B3', '2024年度'], ['C3', '2025年度'], ['D3', '2026年9月末'],
    ['A4', '合成总资产'], ['A5', '合成营业收入'], ['A6', '测试口径：合并，单位：万元；仅用于上传与原生解析验收。'],
  ];
  const rowContents = new Map<number, string[]>();
  for (const [ref, text] of strings) {
    const row = Number(ref.match(/\d+$/)![0]), escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    rowContents.set(row, [...(rowContents.get(row) ?? []), `<c r="${ref}" t="inlineStr"><is><t>${escaped}</t></is></c>`]);
  }
  for (const [row, numbers] of [[4, [111, 222, 333]], [5, [11, 22, 33]]] as const)
    for (const [index, value] of numbers.entries()) rowContents.set(row, [...(rowContents.get(row) ?? []), `<c r="${String.fromCharCode(66 + index)}${row}"><v>${value}</v></c>`]);
  const worksheet = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D6"/><sheetData>${[...rowContents.entries()].sort(([a], [b]) => a - b).map(([row, cells]) => `<row r="${row}">${cells.join('')}</row>`).join('')}</sheetData></worksheet>`);
  const normal = await xlsxSample(worksheet);
  return {
    normalXlsx: fixture('normalXlsx', `${marker}-纯合成财务报表.xlsx`, media, normal, 'xlsx', 'Native XLSX: explicit synthetic declaration, reporting periods, invented figures and unit/scope labels.'),
    damagedXlsx: fixture('damagedXlsx', `${marker}-伪结构财务报表.xlsx`, media, Buffer.from(`PK synthetic invalid workbook ${marker}`), 'damaged-xlsx', 'Not a valid Office ZIP; raw upload is not content inspection.', ['MATERIAL_UNREADABLE']),
    truncatedXlsx: fixture('truncatedXlsx', `${marker}-截断财务报表.xlsx`, media, normal.subarray(0, -10), 'truncated-xlsx', 'Native synthetic financial workbook with ten ZIP trailer bytes removed.', ['MATERIAL_UNREADABLE']),
  };
}

/** Exact Playwright upload payload; copying avoids later mutation of shared fixture bytes. */
export function asUploadFile(value: LocalPrelaunchFixture): {name: string; mimeType: string; buffer: Buffer} {
  return {name: value.name, mimeType: value.mimeType, buffer: Buffer.from(value.buffer)};
}
