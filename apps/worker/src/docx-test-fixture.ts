import { crc32 as nativeCrc32, deflateRawSync } from 'node:zlib';

// Synthetic OOXML package for the worker queue integration test only.
export function makeWorkerDocxFixture(options:{externalLink?:boolean;text?:string;paragraphs?:string[];byteSize?:number;paddingByte?:number}={}):Buffer {
  const pRel='http://schemas.openxmlformats.org/package/2006/relationships';
  const pTypes='http://schemas.openxmlformats.org/package/2006/content-types';
  const pWord='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const pOffice='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const entries=[
    ['[Content_Types].xml',`<Types xmlns="${pTypes}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels',`<Relationships xmlns="${pRel}"><Relationship Id="rIdDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml',`<w:document xmlns:w="${pWord}" xmlns:r="${pOffice}"><w:body><w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Synthetic worker delivery fixture</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`],
    ['word/_rels/document.xml.rels',`<Relationships xmlns="${pRel}"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/synthetic" TargetMode="External"/></Relationships>`]
  ].filter(([filename])=>options.externalLink!==false || filename!=='word/_rels/document.xml.rels')
    .map(([filename,content])=>options.externalLink===false && filename==='word/document.xml'
      ? [filename,`<w:document xmlns:w="${pWord}"><w:body><w:p><w:r><w:t>Synthetic worker upload fixture</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`] as const
      : [filename,content] as const).map(([filename,content])=>[filename,options.text!==undefined&&filename==='word/document.xml'
        ? content.replace(/Synthetic worker (?:upload|delivery) fixture/g,options.text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')) : content] as const)
    .map(([filename,content])=>[filename,options.paragraphs!==undefined&&filename==='word/document.xml'
      ? content.replace(/<w:p>[\s\S]*?<\/w:p>/,options.paragraphs.map(text=>`<w:p><w:r><w:t>${text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</w:t></w:r></w:p>`).join(''))
      : content] as const);
  // Exact-size upload fixtures keep the real DOCX package. Benign stored padding parts
  // exercise full byte reads without a giant XML part, excessive expansion or fake media.
  const stored=options.byteSize!==undefined;
  const parts:Array<readonly [string,Buffer]>=entries.map(([name,content])=>[name,Buffer.from(stored&&name==='[Content_Types].xml'
    ? content.replace('</Types>','<Default Extension="dat" ContentType="application/octet-stream"/></Types>') : content)]);
  if(stored){
    const size=options.byteSize!,fill=options.paddingByte??120,maxPart=24*1024*1024;
    if(!Number.isSafeInteger(size)||size<1||size>100*1024*1024||!Number.isInteger(fill)||fill<33||fill>126||fill===60)
      throw new Error('Invalid exact-size synthetic DOCX request');
    const names=Array.from({length:Math.ceil(size/maxPart)},(_,i)=>`word/synthetic-padding-${i}.dat`);
    const overhead=22+parts.reduce((sum,[name,bytes])=>sum+76+2*Buffer.byteLength(name)+bytes.length,0)
      +names.reduce((sum,name)=>sum+76+2*Buffer.byteLength(name),0);
    let remaining=size-overhead;
    if(remaining<names.length)throw new Error('Synthetic DOCX target is smaller than its package');
    for(let i=0;i<names.length;i++){
      const length=Math.ceil(remaining/(names.length-i));
      parts.push([names[i]!,Buffer.alloc(length,fill)]);remaining-=length;
    }
  }
  const crc32=(bytes:Buffer)=>{
    let value=0xffffffff;
    for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;}
    return (value^0xffffffff)>>>0;
  };
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [filename,bytes] of parts){
    const name=Buffer.from(filename),compressed=stored?bytes:deflateRawSync(bytes),crc=stored?nativeCrc32(bytes):crc32(bytes);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(stored?0:8,8);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,compressed);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(0x0314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);record.writeUInt16LE(stored?0:8,10);
    record.writeUInt32LE(crc,16);record.writeUInt32LE(compressed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE((0o100644<<16)>>>0,38);record.writeUInt32LE(offset,42);
    central.push(record,name);offset+=header.length+name.length+compressed.length;
  }
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(parts.length,8);end.writeUInt16LE(parts.length,10);end.writeUInt32LE(central.reduce((size,part)=>size+part.length,0),12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}
