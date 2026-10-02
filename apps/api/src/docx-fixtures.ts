import { deflateRawSync } from 'node:zlib';

// Synthetic OOXML fixture only; it exercises package structure and is not provider or content review evidence.
export function makeSyntheticDocxFixture(options:{text?:string;stored?:boolean}={}):Buffer {
  const relationships='http://schemas.openxmlformats.org/package/2006/relationships';
  const types='http://schemas.openxmlformats.org/package/2006/content-types';
  const word='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const officeRel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files=[
    ['[Content_Types].xml',`<?xml version="1.0"?><Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels',`<?xml version="1.0"?><Relationships xmlns="${relationships}"><Relationship Id="rIdDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml',`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${word}" xmlns:r="${officeRel}"><w:body><w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Synthetic Word delivery fixture</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`],
    ['word/_rels/document.xml.rels',`<?xml version="1.0"?><Relationships xmlns="${relationships}"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/synthetic" TargetMode="External"/></Relationships>`]
  ] as const;
  const table=(()=>{
    const values=new Uint32Array(256);
    for(let n=0;n<256;n++){let value=n;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;values[n]=value>>>0;}
    return values;
  })();
  const crc32=(bytes:Buffer)=>{
    let value=0xffffffff;
    for(const byte of bytes)value=table[(value^byte)&0xff]!^(value>>>8);
    return (value^0xffffffff)>>>0;
  };
  const local:Buffer[]=[],central:Buffer[]=[];
  let offset=0;
  for(const [filename,content] of files){
    const name=Buffer.from(filename),bytes=Buffer.from(filename==='word/document.xml'&&options.text?content.replace('Synthetic Word delivery fixture',options.text):content),compressed=options.stored?bytes:deflateRawSync(bytes),crc=crc32(bytes);
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(options.stored?0:8,8);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,compressed);
    const record=Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(0x0314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);record.writeUInt16LE(options.stored?0:8,10);
    record.writeUInt32LE(crc,16);record.writeUInt32LE(compressed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);
    record.writeUInt32LE((0o100644<<16)>>>0,38);record.writeUInt32LE(offset,42);
    central.push(record,name);
    offset+=header.length+name.length+compressed.length;
  }
  const localBytes=Buffer.concat(local),centralBytes=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(localBytes.length,16);
  return Buffer.concat([localBytes,centralBytes,end]);
}
