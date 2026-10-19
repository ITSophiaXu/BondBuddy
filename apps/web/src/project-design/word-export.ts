// Small, dependency-free OOXML writer for synthetic design examples only.
// It does not parse or modify uploaded documents. ZIP entries use STORE + CRC32.
export type WordParagraph = { text: string; before?: string; comment?: string; heading?: boolean };
const xml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const enc = new TextEncoder();
function zip(files: Record<string, string>) {
  const chunks: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  const header = (size: number) => { const bytes = new Uint8Array(size); return { bytes, v: new DataView(bytes.buffer) }; };
  const crc32 = (data: Uint8Array) => { let n = 0xffffffff; for (const b of data) { n ^= b; for (let k = 0; k < 8; k++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  for (const [name, value] of Object.entries(files)) {
    const path = enc.encode(name), data = enc.encode(value), crc = crc32(data), h = header(30), c = header(46);
    h.v.setUint32(0, 0x04034b50, true); h.v.setUint16(4, 20, true); h.v.setUint16(6, 0x800, true); h.v.setUint16(12, 33, true);
    h.v.setUint32(14, crc, true); h.v.setUint32(18, data.length, true); h.v.setUint32(22, data.length, true); h.v.setUint16(26, path.length, true);
    c.v.setUint32(0, 0x02014b50, true); c.v.setUint16(4, 20, true); c.v.setUint16(6, 20, true); c.v.setUint16(8, 0x800, true); c.v.setUint16(14, 33, true);
    c.v.setUint32(16, crc, true); c.v.setUint32(20, data.length, true); c.v.setUint32(24, data.length, true); c.v.setUint16(28, path.length, true); c.v.setUint32(42, offset, true);
    chunks.push(h.bytes, path, data); central.push(c.bytes, path); offset += h.bytes.length + path.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0), end = header(22);
  end.v.setUint32(0, 0x06054b50, true); end.v.setUint16(8, central.length / 2, true); end.v.setUint16(10, central.length / 2, true); end.v.setUint32(12, centralSize, true); end.v.setUint32(16, offset, true);
  const all = [...chunks, ...central, end.bytes], bytes = new Uint8Array(offset + centralSize + 22); let cursor = 0;
  for (const chunk of all) { bytes.set(chunk, cursor); cursor += chunk.length; } return bytes;
}
export function wordParts(title: string, paragraphs: WordParagraph[], tracked: boolean) {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', prefix = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const run = (text: string, deleted = false) => `<w:r><w:${deleted ? 'delText' : 't'} xml:space="preserve">${xml(text)}</w:${deleted ? 'delText' : 't'}></w:r>`;
  const rows = [{ text: title, heading: true }, { text: '本地设计示例：以下均为合成片段，未读取或修改上传原文，不可作为业务成果。' }, ...paragraphs];
  const body = rows.map((p, i) => `<w:p><w:pPr><w:spacing w:after="160"/>${p.heading ? '<w:rPr><w:b/><w:sz w:val="30"/></w:rPr>' : ''}</w:pPr>${tracked && p.comment ? `<w:commentRangeStart w:id="${i}"/>` : ''}${tracked && p.before !== undefined && p.before !== p.text ? `<w:del w:id="${i * 2}" w:author="BondBuddy" w:date="2026-10-19T00:00:00Z">${run(p.before, true)}</w:del><w:ins w:id="${i * 2 + 1}" w:author="BondBuddy" w:date="2026-10-19T00:00:00Z">${run(p.text)}</w:ins>` : run(p.text)}${tracked && p.comment ? `<w:commentRangeEnd w:id="${i}"/><w:r><w:commentReference w:id="${i}"/></w:r>` : ''}</w:p>`).join('');
  const comments = rows.map((p, i) => p.comment ? `<w:comment w:id="${i}" w:author="BondBuddy" w:date="2026-10-19T00:00:00Z"><w:p>${run(p.comment)}</w:p></w:comment>` : '').join('');
  return {
    '[Content_Types].xml': `${prefix}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${tracked ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ''}</Types>`,
    '_rels/.rels': `${prefix}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${prefix}<w:document xmlns:w="${ns}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
    ...(tracked ? {
      'word/_rels/document.xml.rels': `${prefix}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="comments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`,
      'word/comments.xml': `${prefix}<w:comments xmlns:w="${ns}">${comments}</w:comments>`,
    } : {}),
  };
}
export function wordBytes(title: string, paragraphs: WordParagraph[], tracked: boolean) { return zip(wordParts(title, paragraphs, tracked)); }
export function downloadWord(title: string, paragraphs: WordParagraph[], tracked = false) {
  const bytes = wordBytes(title, paragraphs, tracked);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  const a = document.createElement('a'); a.href = url; a.download = title.replace(/[\\/:*?"<>|]/g, '_') + '_设计示例.docx'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
