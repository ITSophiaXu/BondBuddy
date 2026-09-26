#!/usr/bin/env node
// Realistic-shaped SYNTHETIC large materials for parse capacity probes (no real issuer data).
// Usage: node large-sample.mjs <txt|txt-oversized-line|pdf-text|pdf-scan|docx-text> <size> <out-path>
//   txt <MiB>        prospectus-like UTF-8 Chinese text lines
//   txt-oversized-line  one pathological line above the parser's explicit 16 Ki-character record limit
//   pdf-text <pages> multi-page PDF with a native text layer (Helvetica, ~60 lines/page)
//   pdf-scan <MiB>   text-layer cover page + pages carrying one uncompressed grayscale image each
//   docx-text <MiB>  DOCX whose document.xml holds <MiB> of paragraph XML (needs the repo dev dependencies)
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';

const [kind, sizeArg, out] = process.argv.slice(2);
const size = Number(sizeArg);
if (!kind || !Number.isFinite(size) || size <= 0 || !out) { console.error('usage: large-sample.mjs <txt|pdf-text|pdf-scan|docx-text> <size> <out>'); process.exit(2); }
const MiB = 1024 * 1024;
const zh = ['本期债券发行规模不超过人民币10亿元（含），票面利率询价区间为2.50%-3.50%。', '发行人最近三年末资产负债率分别为58.21%、60.03%和61.47%。',
  '本期债券募集资金扣除发行费用后拟用于偿还有息债务及补充流动资金。', '截至2024年末，发行人合并口径有息负债余额为人民币236.58亿元。',
  '本期债券由合成担保人提供全额无条件不可撤销的连带责任保证担保。', '主承销商、受托管理人：合成证券股份有限公司（示例数据）。'];
const en = ['Synthetic prospectus section: the issuer total assets were RMB 482.37 hundred million at year end 2024.',
  'Use of proceeds: repay interest-bearing debt and supplement working capital after issuance costs.',
  'Credit enhancement: full unconditional irrevocable joint liability guarantee by a synthetic guarantor.',
  'Coupon range 2.50%-3.50%, term 3+2 years, issuer call and investor put options at the end of year 3.'];

function writer(path) {
  const stream = createWriteStream(path);
  let offset = 0;
  return {
    get offset() { return offset; },
    async write(chunk) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1'); offset += b.length; if (!stream.write(b)) await new Promise(r => stream.once('drain', r)); },
    async end() { await new Promise((r, j) => stream.end(err => err ? j(err) : r())); },
  };
}

async function pdf(pages) {
  // pages: array of { text: string[] } or { image: Buffer, width, height }
  const w = writer(out);
  const offsets = [];
  const obj = async (n, body, stream) => {
    offsets[n] = w.offset;
    await w.write(`${n} 0 obj\n${body}\n`);
    if (stream) { await w.write('stream\n'); await w.write(stream); await w.write('\nendstream\n'); }
    await w.write('endobj\n');
  };
  await w.write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  await obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  await obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  await obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], n = 4 + i * 3;
    const text = p.text ?? [`Synthetic scanned page ${i + 1}`];
    const esc = s => s.replace(/[\\()]/g, m => `\\${m}`);
    let content = `BT /F1 9 Tf 11 TL 36 806 Td ${text.map(l => `(${esc(l)}) '`).join(' ')} ET\n`;
    if (p.image) content += `q 523 0 0 700 36 60 cm /Im1 Do Q\n`;
    const resources = p.image ? `<< /Font << /F1 3 0 R >> /XObject << /Im1 ${n + 2} 0 R >> >>` : '<< /Font << /F1 3 0 R >> >>';
    await obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${n + 1} 0 R >>`);
    await obj(n + 1, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>`, content);
    if (p.image) await obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${p.image.length} >>`, p.image);
    else await obj(n + 2, '<< >>');
  }
  const count = 4 + pages.length * 3;
  const xref = w.offset;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  await w.write(`${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  await w.end();
}

if (kind === 'txt') {
  const w = writer(out);
  let line = 0;
  while (w.offset < size * MiB) {
    line++;
    await w.write(Buffer.from(line % 40 === 1 ? `第${Math.ceil(line / 40)}节 合成募集说明书章节（示例数据）\n` : `${zh[line % zh.length]}（第${line}行）\n`));
  }
  await w.end();
} else if (kind === 'txt-oversized-line') {
  const w=writer(out);
  await w.write(`${'x'.repeat(16 * 1024 + 1)}\n`);
  await w.end();
} else if (kind === 'pdf-text') {
  await pdf(Array.from({ length: size }, (_, p) => ({ text: Array.from({ length: 60 }, (_, l) => `${p + 1}.${l + 1} ${en[(p + l) % en.length]}`) })));
} else if (kind === 'pdf-scan') {
  const width = 2480, height = 3508, pageBytes = width * height; // A4 at 300 dpi, 8-bit gray
  const count = Math.max(1, Math.round(size * MiB / pageBytes));
  const image = randomBytes(pageBytes);
  await pdf([{ text: en }, ...Array.from({ length: count }, () => ({ image, width, height }))]);
} else if (kind === 'docx-text') {
  const { ZipFile } = await import('yazl');
  const zip = new ZipFile();
  const rels = (items) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;
  zip.addBuffer(Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), '[Content_Types].xml');
  zip.addBuffer(Buffer.from(rels([['rId1', 'officeDocument', 'word/document.xml']])), '_rels/.rels');
  const parts = ['<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'];
  let bytes = 0, i = 0;
  while (bytes < size * MiB) { const p = `<w:p><w:r><w:t>${zh[i % zh.length]}（第${++i}段）</w:t></w:r></w:p>`; parts.push(p); bytes += Buffer.byteLength(p); }
  parts.push('</w:body></w:document>');
  zip.addBuffer(Buffer.from(parts.join('')), 'word/document.xml', { compress: true });
  zip.end();
  await new Promise((resolve, reject) => zip.outputStream.pipe(createWriteStream(out)).on('close', resolve).on('error', reject));
} else { console.error(`unknown kind ${kind}`); process.exit(2); }
