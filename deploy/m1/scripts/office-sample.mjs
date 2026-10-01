#!/usr/bin/env node
// Usage: node office-sample.mjs <docx|xlsx> <out-path>  (needs the repo dev dependencies; synthetic data only)
// Synthetic ~100 MiB DOCX/XLSX: valid package XML plus four ~24.7 MiB incompressible media parts.
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { ZipFile } from 'yazl';
const [kind, out] = process.argv.slice(2);
const zip = new ZipFile();
const add = (name, text) => zip.addBuffer(Buffer.from(text), name, { compress: true, compressionLevel: 9 });
const rels = (items) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const media = [0, 1, 2, 3].map(i => [`rIdImg${i}`, 'image', `media/synthetic-${i}.bin`]);
if (kind === 'docx') {
  add('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  add('_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']]));
  add('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>${media.map(([id]) => `<w:p><w:r><w:t>Synthetic figure</w:t></w:r><w:r><w:drawing><a:blip r:embed="${id}"/></w:drawing></w:r></w:p>`).join('')}</w:body></w:document>`);
  add('word/_rels/document.xml.rels', rels(media));
} else {
  add('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>');
  add('_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml']]));
  add('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic" sheetId="1" r:id="rId1"/></sheets></workbook>');
  add('xl/_rels/workbook.xml.rels', rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ...media]));
  const rows = Array.from({ length: 20000 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${r}</v></c><c r="B${r + 1}"><v>${(r * 1.5).toFixed(1)}</v></c></row>`).join('');
  add('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
}
for (const [, , target] of media) zip.addBuffer(randomBytes(24 * 1024 * 1024 + 700 * 1024), `${kind === 'docx' ? 'word' : 'xl'}/${target}`, { compress: true, compressionLevel: 1 });
zip.end();
await new Promise((resolve, reject) => zip.outputStream.pipe(createWriteStream(out)).on('close', resolve).on('error', reject));
