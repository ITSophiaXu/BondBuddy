import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { DOCX_LIMITS, inspectDocx, readBoundedZipParts, readDocxBodyText } from './docx-inspector.js';

const relNs='http://schemas.openxmlformats.org/package/2006/relationships';
const typesNs='http://schemas.openxmlformats.org/package/2006/content-types';
const wordNs='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const officeRelNs='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relsType='application/vnd.openxmlformats-package.relationships+xml';
const mainType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

type FixturePart={name:string;bytes:Buffer;method?:0|8;flags?:number;crcXor?:number;compressedSize?:number;uncompressedSize?:number;localUncompressedSize?:number;compressedSuffix?:Buffer;unixMode?:number};

function crc32(bytes:Buffer):number {
  let value=0xffffffff;
  for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;}
  return (value^0xffffffff)>>>0;
}

function part(name:string,value:string|Buffer,options:Omit<FixturePart,'name'|'bytes'>={}):FixturePart {
  return {name,bytes:Buffer.isBuffer(value)?value:Buffer.from(value),...options};
}

function zip(parts:FixturePart[]):Buffer {
  const local:Buffer[]=[],central:Buffer[]=[];
  let offset=0;
  for(const item of parts){
    const name=Buffer.from(item.name,'utf8'),method=item.method??8,flags=item.flags??0x0800;
    const compressed=Buffer.concat([method===0?item.bytes:deflateRawSync(item.bytes),item.compressedSuffix??Buffer.alloc(0)]);
    const crc=(crc32(item.bytes)^(item.crcXor??0))>>>0;
    const compressedSize=item.compressedSize??compressed.length;
    const uncompressedSize=item.uncompressedSize??item.bytes.length;
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(flags,6);header.writeUInt16LE(method,8);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(compressedSize,18);header.writeUInt32LE(item.localUncompressedSize??uncompressedSize,22);header.writeUInt16LE(name.length,26);header.writeUInt16LE(0,28);
    local.push(header,name,compressed);

    const record=Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(0x0314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(flags,8);record.writeUInt16LE(method,10);
    record.writeUInt32LE(crc,16);record.writeUInt32LE(compressedSize,20);record.writeUInt32LE(uncompressedSize,24);record.writeUInt16LE(name.length,28);
    record.writeUInt16LE(0,30);record.writeUInt16LE(0,32);record.writeUInt16LE(0,34);record.writeUInt32LE(0,38);
    const directory=item.name.endsWith('/');
    record.writeUInt32LE(((item.unixMode??(directory?0o040755:0o100644))<<16)>>>0,38);
    record.writeUInt32LE(offset,42);
    central.push(record,name);
    offset+=header.length+name.length+compressed.length;
  }
  const localBytes=Buffer.concat(local),centralBytes=Buffer.concat(central),eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(parts.length,8);eocd.writeUInt16LE(parts.length,10);
  eocd.writeUInt32LE(centralBytes.length,12);eocd.writeUInt32LE(localBytes.length,16);eocd.writeUInt16LE(0,20);
  return Buffer.concat([localBytes,centralBytes,eocd]);
}

function docx(options:{document?:string;documentRels?:string;contentTypes?:string;extra?:FixturePart[];omitDocument?:boolean;badDocumentCrc?:boolean;documentSuffix?:Buffer}={}):Buffer {
  const document=options.document??`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNs}" xmlns:r="${officeRelNs}"><w:body><w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>BondBuddy synthetic fixture</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`;
  const documentRels=options.documentRels??`<?xml version="1.0"?><Relationships xmlns="${relNs}"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/synthetic" TargetMode="External"/></Relationships>`;
  const contentTypes=`<?xml version="1.0"?><Types xmlns="${typesNs}"><Default Extension="rels" ContentType="${relsType}"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="txt" ContentType="text/plain"/><Override PartName="/word/document.xml" ContentType="${mainType}"/></Types>`;
  const rootRels=`<?xml version="1.0"?><Relationships xmlns="${relNs}"><Relationship Id="rIdDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const parts=[
    part('[Content_Types].xml',options.contentTypes??contentTypes),
    part('_rels/',Buffer.alloc(0),{method:0}),
    part('_rels/.rels',rootRels),
    part('word/',Buffer.alloc(0),{method:0}),
    ...(options.omitDocument?[]:[part('word/document.xml',document,{crcXor:options.badDocumentCrc?1:0,compressedSuffix:options.documentSuffix})]),
    part('word/_rels/',Buffer.alloc(0),{method:0}),
    part('word/_rels/document.xml.rels',documentRels),
    ...(options.extra??[])
  ];
  return zip(parts);
}

test('synthetic valid WordprocessingML package passes bounded OOXML and reference inspection',()=>{
  const result=inspectDocx(docx());
  assert.equal(result.quality_status,'passed',result.failure_codes.join(','));
  assert.deepEqual(result.required_parts,['[Content_Types].xml','_rels/.rels','word/document.xml']);
  assert.equal(result.checks.zip_structure,'passed');
  assert.equal(result.checks.entry_integrity,'passed');
  assert.equal(result.checks.xml_well_formedness,'passed');
  assert.equal(result.checks.ooxml_relationships,'passed');
  assert.equal(result.checks.word_document,'passed');
  assert.ok(result.zip.entry_count>=7,'explicit ZIP directory entries are accepted');
});

for(const method of [0,8] as const)test(`empty ZIP directory with compression method ${method} passes every bounded reader`,()=>{
  if(method===8)assert.equal(deflateRawSync(Buffer.alloc(0)).toString('hex'),'0300');
  const bytes=docx({extra:[part('word/empty/',Buffer.alloc(0),{method})]});
  const result=inspectDocx(bytes);
  assert.equal(result.quality_status,'passed',result.failure_codes.join(','));
  assert.equal(result.checks.entry_integrity,'passed');
  assert.match(readDocxBodyText(bytes)??'',/BondBuddy synthetic fixture/);
  const parts=readBoundedZipParts(bytes);
  assert.equal(parts.has('word/empty/'),false,'directory metadata is not exposed as a file');
  assert.ok(parts.has('word/document.xml'));
});

const directoryPayload=Buffer.from('hidden directory content');
for(const [label,directory,code] of [
  ['declared nonempty payload',part('word/empty/',directoryPayload),'DOCX_ZIP_INVALID'],
  ['payload disguised as empty',part('word/empty/',directoryPayload,{uncompressedSize:0,crcXor:crc32(directoryPayload)}),'DOCX_DECOMPRESSION_FAILED'],
  ['stored payload disguised as empty',part('word/empty/',directoryPayload,{method:0,uncompressedSize:0,crcXor:crc32(directoryPayload)}),'DOCX_ZIP_SIZE_MISMATCH'],
  ['one-byte payload disguised as empty',part('word/empty/','x',{uncompressedSize:0,crcXor:crc32(Buffer.from('x'))}),'DOCX_ZIP_SIZE_MISMATCH'],
  ['stored directory with wrong CRC',part('word/empty/',Buffer.alloc(0),{method:0,crcXor:1}),'DOCX_CRC_MISMATCH'],
  ['deflated directory with wrong CRC',part('word/empty/',Buffer.alloc(0),{crcXor:1}),'DOCX_CRC_MISMATCH'],
  ['trailing deflate data',part('word/empty/',Buffer.alloc(0),{compressedSuffix:Buffer.from('hidden suffix')}),'DOCX_DEFLATE_TRAILING_DATA'],
  ['local and central size mismatch',part('word/empty/',Buffer.alloc(0),{localUncompressedSize:1}),'DOCX_ZIP_INVALID'],
  ['Unix directory mode with hidden payload',part('word/empty',directoryPayload,{uncompressedSize:0,crcXor:crc32(directoryPayload),unixMode:0o040755}),'DOCX_DECOMPRESSION_FAILED'],
  ['Unix directory mode with wrong CRC',part('word/empty',Buffer.alloc(0),{crcXor:1,unixMode:0o040755}),'DOCX_CRC_MISMATCH'],
] as const)test(`ZIP directory rejects ${label} in every bounded reader`,()=>{
  const bytes=docx({extra:[directory]}),result=inspectDocx(bytes);
  assert.equal(result.quality_status,'failed');
  assert.ok(result.failure_codes.includes(code),result.failure_codes.join(','));
  assert.equal(readDocxBodyText(bytes),null);
  assert.throws(()=>readBoundedZipParts(bytes));
  assert.throws(()=>readBoundedZipParts(bytes,()=>false),'directory validation cannot be bypassed by a file filter');
});

test('synthetic hostile DOCX variants fail closed before they can be promoted',()=>{
  const cases:Array<[string,Buffer,string]>=[
    ['missing required Word part',docx({omitDocument:true}),'DOCX_REQUIRED_PART_MISSING'],
    ['malformed XML',docx({document:'<w:document><w:body>'}),'DOCX_XML_MALFORMED'],
    ['Word body namespace rebound to an unrelated vocabulary',docx({document:`<w:document xmlns:w="${wordNs}"><w:body xmlns:w="urn:attacker"><w:p/></w:body></w:document>`}),'DOCX_WORD_DOCUMENT_INVALID'],
    ['Word paragraph namespace rebound to an unrelated vocabulary',docx({document:`<w:document xmlns:w="${wordNs}"><w:body><w:p xmlns:w="urn:attacker"/></w:body></w:document>`}),'DOCX_WORD_DOCUMENT_EMPTY'],
    ['corrupted entry CRC',docx({badDocumentCrc:true}),'DOCX_CRC_MISMATCH'],
    ['trailing compressed-member bytes',docx({documentSuffix:Buffer.from('hidden payload')}),'DOCX_DEFLATE_TRAILING_DATA'],
    ['missing relationship reference',docx({document:`<w:document xmlns:w="${wordNs}" xmlns:r="${officeRelNs}"><w:body><w:p><w:hyperlink r:id="rIdMissing"/></w:p></w:body></w:document>`}),'DOCX_RELATIONSHIP_REFERENCE_MISSING'],
    ['missing relationship target',docx({documentRels:`<Relationships xmlns="${relNs}"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="word/missing.xml"/></Relationships>`}),'DOCX_RELATIONSHIP_TARGET_MISSING'],
    ['ambiguous empty relationship path segment',docx({documentRels:`<Relationships xmlns="${relNs}"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="word//document.xml"/></Relationships>`}),'DOCX_RELATIONSHIP_TARGET_INVALID'],
    ['relationship child namespace substitution',docx({documentRels:`<Relationships xmlns="${relNs}"><Relationship xmlns="urn:attacker" Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/></Relationships>`}),'DOCX_RELATIONSHIPS_INVALID'],
    ['content type child namespace substitution',docx({contentTypes:`<Types xmlns="${typesNs}"><Default xmlns="urn:attacker" Extension="rels" ContentType="${relsType}"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mainType}"/></Types>`}),'DOCX_CONTENT_TYPES_INVALID'],
    ['encrypted entry',zip([part('[Content_Types].xml','x',{flags:0x0801})]),'DOCX_ENCRYPTED'],
    ['executable bytes after archive',Buffer.concat([docx(),Buffer.from('MZpolyglot')]),'DOCX_ZIP_TRAILING_OR_POLYGLOT'],
    ['DTD and entity declarations',docx({document:`<!DOCTYPE w:document [<!ENTITY x "hello">]><w:document xmlns:w="${wordNs}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`}),'DOCX_XML_DTD_FORBIDDEN'],
    ['unbound relationship namespace prefix',docx({document:`<w:document xmlns:w="${wordNs}"><w:body><w:p><w:hyperlink r:id="rIdLink"/></w:p></w:body></w:document>`}),'DOCX_XML_NAMESPACE_INVALID'],
    ['CRC-valid content mismatch',zip([part('[Content_Types].xml','x',{crcXor:1})]),'DOCX_REQUIRED_PART_MISSING']
  ];
  for(const [label,bytes,code] of cases){
    const result=inspectDocx(bytes);
    assert.equal(result.quality_status,'failed',label);
    assert.ok(result.failure_codes.includes(code),`${label}: ${result.failure_codes.join(',')}`);
  }
});

test('archive and expansion limits reject ZIP bombs and oversized packages before extraction',()=>{
  const ratioBomb=docx({extra:[part('word/notes.txt','A'.repeat(80_000))]});
  const ratioResult=inspectDocx(ratioBomb);
  assert.ok(ratioResult.failure_codes.includes('DOCX_COMPRESSION_RATIO_LIMIT'));

  const oversized=docx({extra:[part('word/large.txt','tiny',{compressedSize:DOCX_LIMITS.partBytes+1,uncompressedSize:DOCX_LIMITS.partBytes+1})]});
  const sizeResult=inspectDocx(oversized);
  assert.ok(sizeResult.failure_codes.includes('DOCX_PART_SIZE_LIMIT'));

  const tooLarge=Buffer.alloc(DOCX_LIMITS.archiveBytes+1);
  const archiveResult=inspectDocx(tooLarge);
  assert.ok(archiveResult.failure_codes.includes('DOCX_ARCHIVE_SIZE_LIMIT'));

  const tooMany=docx({extra:Array.from({length:DOCX_LIMITS.entries},(_,index)=>part(`extra-${index}.txt`,'x'))});
  const countResult=inspectDocx(tooMany);
  assert.ok(countResult.failure_codes.includes('DOCX_ENTRY_COUNT_LIMIT'));
});
