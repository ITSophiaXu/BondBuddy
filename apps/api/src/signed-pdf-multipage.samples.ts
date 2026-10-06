// Structural synthetic controls, not cryptographic signatures or customer content.
export function multipageSignedPdf(options: { catalog?: string; widget?: string; hidden?: string; fieldType?: string; recursiveAppearance?: boolean; unsignedRevision?: boolean } = {}): Buffer {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R] /SigFlags 3 >> ${options.catalog ?? ''} >>`,
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 5 0 R /Annots [7 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    ...[3,4].map((page,index)=>`<< /Type /Annot /Subtype /Widget /FT /${options.fieldType ?? 'Sig'} /T (synthetic${index}) /Rect [0 0 1 1] /P ${page} 0 R /F 4 /V 8 0 R /AP << /N 9 0 R >> ${options.widget ?? ''} >>`),
    '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 0000000000 0000000000 0000000000] /Contents <01> >>',
    `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << ${options.recursiveAppearance ? '/XObject << /Self 9 0 R >>' : ''} >> /Length 0 >>\nstream\n\nendstream`
  ];
  if (options.hidden) objects.push(options.hidden);
  let source = '%PDF-1.4\n% synthetic multipage signature fixture\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index+1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10,'0')} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const start = source.indexOf('<01>'), end = start+4;
  source = source.replace('0000000000 0000000000 0000000000',[start,end,source.length-end].map(n=>String(n).padStart(10,'0')).join(' '));
  if(options.unsignedRevision) {
    const next = source.length;
    source += `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R /Prev ${xref} >>\nstartxref\n${next}\n%%EOF\n`;
  }
  return Buffer.from(source,'ascii');
}
