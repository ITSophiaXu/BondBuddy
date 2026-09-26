import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { M1_UPLOAD_MIME_TYPES } from '@bondbuddy/contracts';
import { encode as encodeJpeg } from 'jpeg-js';
import { PNG as PngImage } from 'pngjs';
import { ZipFile } from 'yazl';

const [DOCX, PDF, XLSX, CSV, TEXT, PNG, JPEG] = M1_UPLOAD_MIME_TYPES;
export { DOCX, PDF, XLSX, CSV, TEXT, PNG, JPEG };
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const PDF_PASSWORD_PADDING = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
]);

function padPdfPassword(value: string): Buffer {
  const bytes = Buffer.from(value, 'latin1');
  return Buffer.concat([bytes, PDF_PASSWORD_PADDING]).subarray(0, 32);
}

function rc4(key: Buffer, input: Buffer): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < state.length; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 0xff;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  const output = Buffer.alloc(input.length);
  let i = 0;
  j = 0;
  for (let offset = 0; offset < input.length; offset++) {
    i = (i + 1) & 0xff;
    j = (j + state[i]!) & 0xff;
    [state[i], state[j]] = [state[j]!, state[i]!];
    output[offset] = input[offset]! ^ state[(state[i]! + state[j]!) & 0xff]!;
  }
  return output;
}

function encryptedPdfValues(fileId: Buffer): { owner: Buffer; user: Buffer } {
  const ownerKey = createHash('md5').update(padPdfPassword('synthetic-owner')).digest().subarray(0, 5);
  const owner = rc4(ownerKey, padPdfPassword(''));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const fileKey = createHash('md5').update(Buffer.concat([padPdfPassword(''), owner, permissions, fileId])).digest().subarray(0, 5);
  return { owner, user: rc4(fileKey, PDF_PASSWORD_PADDING) };
}

export function pdfSample(options: { encrypted?: boolean; javascript?: boolean; corrupt?: boolean; tag?: string } = {}): Buffer {
  const objects = [
    options.javascript
      ? '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>\nendobj\n'
      : '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'
  ];
  if (options.javascript) objects.push('5 0 obj\n<< /S /JavaScript /JS (app.alert\\(1\\)) >>\nendobj\n');
  const fileId = Buffer.from('11'.repeat(16), 'hex');
  const encryptionObjectNumber = objects.length + 1;
  if (options.encrypted) {
    const values = encryptedPdfValues(fileId);
    objects.push(`${encryptionObjectNumber} 0 obj\n<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${values.owner.toString('hex')}> /U <${values.user.toString('hex')}> /P -4 >>\nendobj\n`);
  }

  let document = `%PDF-1.4\n% synthetic ${options.tag ?? ''}\n`;
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(document, 'ascii'));
    document += object;
  }
  const xrefOffset = Buffer.byteLength(document, 'ascii');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const encryptedTail = options.encrypted ? ` /Encrypt ${encryptionObjectNumber} 0 R /ID [<${fileId.toString('hex')}><${fileId.toString('hex')}>]` : '';
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptedTail} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const bytes = Buffer.from(document, 'ascii');
  return options.corrupt ? Buffer.from('%PDF-1.4\ncorrupt structure\n%%EOF\n', 'ascii') : bytes;
}

type ZipPart = { name: string; contents: Buffer; compress?: boolean };

async function createZip(parts: readonly ZipPart[], zeroParts: readonly { name: string; size: number }[] = []): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  const output = archive.outputStream;
  const result = new Promise<Buffer>((resolve, reject) => {
    output.on('data', chunk => chunks.push(Buffer.from(chunk)));
    output.once('error', reject);
    output.once('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const part of parts) archive.addBuffer(part.contents, part.name, { compress: part.compress ?? true, compressionLevel: 9 });
  for (const part of zeroParts) {
    let remaining = part.size;
    const stream = new Readable({
      read() {
        if (remaining <= 0) {
          this.push(null);
          return;
        }
        const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
        const noise = randomBytes(Math.ceil(chunk.length / 2));
        for (let index = 0; index < noise.length; index++) chunk[index * 2 + 1] = noise[index]!;
        remaining -= chunk.length;
        this.push(chunk);
      }
    });
    archive.addReadStream(stream, part.name, { size: part.size, compress: true, compressionLevel: 6 });
  }
  archive.end();
  return result;
}

const wordDocument = Buffer.from(
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic</w:t></w:r></w:p></w:body></w:document>'
);
const wordRelationships = Buffer.from(
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
);
const wordContentTypes = Buffer.from(
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
);

function docxParts(extra: readonly ZipPart[] = [], document = wordDocument): ZipPart[] {
  return [
    { name: '[Content_Types].xml', contents: wordContentTypes },
    { name: '_rels/.rels', contents: wordRelationships },
    { name: 'word/document.xml', contents: document },
    ...extra
  ];
}

export function docxSample(extra: readonly ZipPart[] = [], document = wordDocument): Promise<Buffer> {
  return createZip(docxParts(extra, document));
}

const workbook = Buffer.from(
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic" sheetId="1" r:id="rId1"/></sheets></workbook>'
);
const workbookRelationships = Buffer.from(
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
);
const worksheet = Buffer.from(
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'
);
const xlsxContentTypes = Buffer.from(
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'
);

function xlsxParts(sheet = worksheet, extra: readonly ZipPart[] = []): ZipPart[] {
  return [
    { name: '[Content_Types].xml', contents: xlsxContentTypes },
    { name: '_rels/.rels', contents: Buffer.from(wordRelationships.toString().replace('word/document.xml', 'xl/workbook.xml')) },
    { name: 'xl/workbook.xml', contents: workbook },
    { name: 'xl/_rels/workbook.xml.rels', contents: workbookRelationships },
    { name: 'xl/worksheets/sheet1.xml', contents: sheet },
    ...extra
  ];
}

export function xlsxSample(sheet = worksheet, extra: readonly ZipPart[] = []): Promise<Buffer> {
  return createZip(xlsxParts(sheet, extra));
}

export function pptxSample(): Promise<Buffer> {
  const parts: ZipPart[] = [
    { name: '[Content_Types].xml', contents: Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>') },
    { name: '_rels/.rels', contents: Buffer.from(wordRelationships.toString().replace('word/document.xml', 'ppt/presentation.xml')) },
    { name: 'ppt/presentation.xml', contents: Buffer.from('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>') }
  ];
  return createZip(parts);
}

export function externalRelationshipDocxSample(target: string, type = 'hyperlink'): Promise<Buffer> {
  const escaped = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return docxSample([{ name: 'word/_rels/document.xml.rels', contents: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${escaped}" TargetMode="External"/></Relationships>`) }]);
}

export function externalRelationshipXlsxSample(target: string): Promise<Buffer> {
  const rels = Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/></Relationships>`);
  return createZip(xlsxParts().map(part => part.name === 'xl/_rels/workbook.xml.rels' ? { ...part, contents: rels } : part));
}

export function externalLinkPartXlsxSample(): Promise<Buffer> {
  const parts = xlsxParts().map(part => {
    if (part.name === '[Content_Types].xml') return {
      ...part,
      contents: Buffer.from(part.contents.toString().replace('</Types>', '<Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>'))
    };
    if (part.name === 'xl/_rels/workbook.xml.rels') return {
      ...part,
      contents: Buffer.from(part.contents.toString().replace('</Relationships>', '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>'))
    };
    if (part.name === 'xl/workbook.xml') return {
      ...part,
      contents: Buffer.from(part.contents.toString().replace('</workbook>', '<externalReferences><externalReference r:id="rId2"/></externalReferences></workbook>'))
    };
    return part;
  });
  return createZip([
    ...parts,
    { name: 'xl/externalLinks/externalLink1.xml', contents: Buffer.from('<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1"/></externalLink>') },
    { name: 'xl/externalLinks/_rels/externalLink1.xml.rels', contents: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///synthetic/source.xlsx" TargetMode="External"/></Relationships>') }
  ]);
}

export function activeDocxSample(): Promise<Buffer> {
  return externalRelationshipDocxSample('javascript:alert(1)');
}

export function activeSvgDocxSample(): Promise<Buffer> {
  return docxSample([{ name: 'word/drawings/image.svg', contents: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/image.png"/></svg>') }]);
}

export function neutralExtensionDocxSample(contentType: string, payload: Buffer): Promise<Buffer> {
  const contentTypes = Buffer.from(wordContentTypes.toString().replace(
    '</Types>',
    `<Default Extension="bin" ContentType="${contentType}"/></Types>`
  ));
  const imageDocument = Buffer.from(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p></w:body></w:document>'
  );
  const imageRelationships = Buffer.from(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/payload.bin"/></Relationships>'
  );
  return createZip([
    { name: '[Content_Types].xml', contents: contentTypes },
    { name: '_rels/.rels', contents: wordRelationships },
    { name: 'word/document.xml', contents: imageDocument },
    { name: 'word/_rels/document.xml.rels', contents: imageRelationships },
    { name: 'word/media/payload.bin', contents: payload }
  ]);
}

export function macroDocxSample(): Promise<Buffer> {
  return docxSample([{ name: 'word/vbaProject.bin', contents: Buffer.from('synthetic macro marker') }]);
}

export function macroDefaultDocxSample(): Promise<Buffer> {
  const contentTypes = Buffer.from(wordContentTypes.toString().replace(
    '</Types>',
    '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'
  ));
  return createZip([
    { name: '[Content_Types].xml', contents: contentTypes },
    ...docxParts().slice(1),
    { name: 'word/custom.bin', contents: Buffer.from('synthetic embedded macro marker') }
  ]);
}

export function nestedGzipDocxSample(): Promise<Buffer> {
  return docxSample([{ name: 'word/embedded.dat', contents: Buffer.from([0x1f, 0x8b, 0x08, 0x00]) }]);
}

export function compressedBombSample(): Promise<Buffer> {
  return docxSample([{ name: 'word/repeated-data.bin', contents: Buffer.alloc(1024 * 1024, 0x41) }]);
}

export function entryCountBombSample(): Promise<Buffer> {
  const extra = Array.from({ length: 1022 }, (_, index) => ({ name: `word/parts/${index}.xml`, contents: Buffer.from('<p/>') }));
  return docxSample(extra);
}

export function expandedSizeBombSample(): Promise<Buffer> {
  return docxSample([{ name: 'word/large.bin', contents: Buffer.alloc(33 * 1024 * 1024) }]);
}

export function encryptedOfficeSample(): Buffer {
  return Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from('EncryptionInfo\0EncryptedPackage\0', 'utf16le')
  ]);
}

export async function encryptedZipSample(): Promise<Buffer> {
  const bytes = Buffer.from(await docxSample());
  for (let offset = 0; offset + 10 < bytes.length; offset++) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 0x0001, offset + 6);
    else if (signature === 0x02014b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 0x0001, offset + 8);
  }
  return bytes;
}

export const textSample = Buffer.from('Synthetic material evidence\n', 'utf8');
export const csvSample = Buffer.from('name,amount\nSynthetic issuer,-100\n', 'utf8');
export const csvFormulaSample = Buffer.from('name,value\nSynthetic issuer,"=HYPERLINK(""https://example.invalid"")"\n', 'utf8');
const pngImage = new PngImage({ width: 1, height: 1 });
Buffer.from([255, 0, 0, 255]).copy(pngImage.data);
export const pngSample = PngImage.sync.write(pngImage);
export const jpegSample = Buffer.from(encodeJpeg({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }, 80).data);
