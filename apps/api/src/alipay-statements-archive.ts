import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import type {AlipayStatementDocument} from './alipay-statements.js';

export const ALIPAY_STATEMENT_ARCHIVE_LIMIT=10*1024*1024;
const maxExpanded=20*1024*1024,maxFile=10*1024*1024,maxEntries=8,maxRatio=100;
export class AlipayArchiveError extends Error{constructor(readonly code:string){super('Alipay archive '+code);this.name='AlipayArchiveError';}}
const fail=(code:string):never=>{throw new AlipayArchiveError(code);};
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const crcTable=Uint32Array.from({length:256},(_,index)=>{let n=index;for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function alipayArchiveCrc32(bytes:Uint8Array){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;}
function decode(bytes:Uint8Array,encoding:'utf-8'|'gbk'){try{return new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{return undefined;}}
function csvText(bytes:Uint8Array):{text:string;encoding:'utf-8'|'gbk'}{
  const bom=bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf,utf8=decode(bytes,'utf-8');
  if(bom){if(utf8===undefined)return fail('CSV_ENCODING_INVALID');return {text:utf8,encoding:'utf-8'};}
  const gbk=decode(bytes,'gbk');
  if(utf8!==undefined&&gbk!==undefined&&utf8!==gbk)return fail('CSV_ENCODING_AMBIGUOUS');
  if(utf8!==undefined)return {text:utf8,encoding:'utf-8'};
  if(gbk!==undefined)return {text:gbk,encoding:'gbk'};
  return fail('CSV_ENCODING_INVALID');
}
function extraFields(bytes:Buffer){let at=0;const ids=new Set<number>();while(at<bytes.length){
  if(at+4>bytes.length)return fail('ZIP_EXTRA_INVALID');const id=bytes.readUInt16LE(at),size=bytes.readUInt16LE(at+2);at+=4;
  if(ids.has(id)||[0x0001,0x9901,0x7075].includes(id)||at+size>bytes.length)return fail('ZIP_EXTRA_UNSUPPORTED');ids.add(id);at+=size;
}}

export type AlipayStatementArchiveDocument={document:AlipayStatementDocument;text:string};
/** No extraction to disk. Text is transient and must not be persisted/logged;
 * only document metadata and successfully normalized fields leave the adapter.
 * ZIP64, encryption, paths, links and ambiguous encodings stay unknown. */
export function readAlipayStatementArchive(input:Uint8Array):AlipayStatementArchiveDocument[]{
  if(input.byteLength<22||input.byteLength>ALIPAY_STATEMENT_ARCHIVE_LIMIT)return fail('ZIP_SIZE_INVALID');
  const bytes=Buffer.from(input);let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-22-65535);at--){if(bytes.readUInt32LE(at)===0x06054b50&&at+22+bytes.readUInt16LE(at+20)===bytes.length){end=at;break;}}
  if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)return fail('ZIP_DIRECTORY_INVALID');
  const count=bytes.readUInt16LE(end+10),directorySize=bytes.readUInt32LE(end+12),directory=bytes.readUInt32LE(end+16);
  if(count<1||count>maxEntries||bytes.readUInt16LE(end+8)!==count||directory+directorySize!==end)return fail('ZIP_DIRECTORY_INVALID');
  let cursor=directory,total=0;const names=new Set<string>(),regions:{start:number;end:number}[]=[],documents:AlipayStatementArchiveDocument[]=[];
  for(let index=0;index<count;index++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)return fail('ZIP_ENTRY_INVALID');
    const madeBy=bytes.readUInt16LE(cursor+4),version=bytes.readUInt16LE(cursor+6),flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16);
    const compressed=bytes.readUInt32LE(cursor+20),expanded=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),disk=bytes.readUInt16LE(cursor+34),attributes=bytes.readUInt32LE(cursor+38),offset=bytes.readUInt32LE(cursor+42);
    if(version>20||flags&~0x080e||![0,8].includes(method)||method===0&&(flags&6)!==0||disk!==0
      ||expanded<1||expanded>maxFile||compressed<1||compressed>ALIPAY_STATEMENT_ARCHIVE_LIMIT||expanded>compressed*maxRatio
      ||nameLength<1||nameLength>512||cursor+46+nameLength+extraLength+commentLength>end)return fail('ZIP_ENTRY_UNSUPPORTED');
    total+=expanded;if(total>maxExpanded)return fail('ZIP_EXPANDED_LIMIT');
    const unixMode=attributes>>>16;
    if(attributes&0x10||madeBy>>>8===3&&(unixMode&0xf000)!==0&&(unixMode&0xf000)!==0x8000)return fail('ZIP_ENTRY_UNSUPPORTED');
    const nameBytes=bytes.subarray(cursor+46,cursor+46+nameLength),name=decode(nameBytes,flags&0x800?'utf-8':'gbk');
    if(name===undefined||name.length>200||/[\x00-\x1f\x7f\\/:]/.test(name)||name==='.'||name==='..'||/[. ]$/.test(name)||!name.toLowerCase().endsWith('.csv'))return fail('ZIP_NAME_INVALID');
    const nameKey=name.normalize('NFC').toLowerCase();if(names.has(nameKey))return fail('ZIP_DUPLICATE_NAME');names.add(nameKey);
    extraFields(bytes.subarray(cursor+46+nameLength,cursor+46+nameLength+extraLength));
    if(offset+30>directory||bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+4)!==version||bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method)return fail('ZIP_LOCAL_MISMATCH');
    const localNameLength=bytes.readUInt16LE(offset+26),localExtraLength=bytes.readUInt16LE(offset+28),dataStart=offset+30+localNameLength+localExtraLength,dataEnd=dataStart+compressed;
    if(localNameLength!==nameLength||dataEnd>directory||!bytes.subarray(offset+30,offset+30+localNameLength).equals(nameBytes))return fail('ZIP_LOCAL_MISMATCH');
    extraFields(bytes.subarray(offset+30+localNameLength,dataStart));
    const localValues=[bytes.readUInt32LE(offset+14),bytes.readUInt32LE(offset+18),bytes.readUInt32LE(offset+22)],expected=[crc,compressed,expanded];
    if(localValues.some((value,i)=>value!==expected[i]&&(!(flags&8)||value!==0)))return fail('ZIP_LOCAL_MISMATCH');
    let regionEnd=dataEnd;
    if(flags&8){if(regionEnd+12>directory)return fail('ZIP_DESCRIPTOR_INVALID');if(bytes.readUInt32LE(regionEnd)===0x08074b50)regionEnd+=4;
      if(regionEnd+12>directory||expected.some((value,i)=>bytes.readUInt32LE(regionEnd+i*4)!==value))return fail('ZIP_DESCRIPTOR_INVALID');regionEnd+=12;}
    const packed=bytes.subarray(dataStart,dataEnd);let unpacked:Buffer;
    try{if(method===0)unpacked=packed;else{const decoded=inflateRawSync(packed,{maxOutputLength:Math.min(expanded+1,maxFile),info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
      if(decoded.engine.bytesWritten!==packed.length)return fail('ZIP_DEFLATE_TRAILING');unpacked=decoded.buffer;}}
    catch(error){if(error instanceof AlipayArchiveError)throw error;return fail('ZIP_DEFLATE_INVALID');}
    if(unpacked.length!==expanded||alipayArchiveCrc32(unpacked)!==crc)return fail('ZIP_CONTENT_MISMATCH');
    const decoded=csvText(unpacked);if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.test(decoded.text))return fail('CSV_TEXT_INVALID');
    // Count before allocating per-line objects: a bounded CSV can still contain
    // millions of blank lines. Preserve UTF-16 line lengths and the trailing
    // empty line while rejecting excess rows as soon as the limit is reached.
    let lineCount=1,lineLength=0;
    for(let at=0;at<decoded.text.length;at++){
      const character=decoded.text.charCodeAt(at);
      if(character===13){if(decoded.text.charCodeAt(at+1)!==10)return fail('CSV_TEXT_LIMIT');at++;}
      if(character===10||character===13){lineCount++;lineLength=0;if(lineCount>100002)return fail('CSV_TEXT_LIMIT');}
      else if(++lineLength>32768)return fail('CSV_TEXT_LIMIT');
    }
    documents.push({document:{nameSha256:digest(nameBytes),sha256:digest(unpacked),byteLength:expanded,encoding:decoded.encoding,lineCount},text:decoded.text});
    regions.push({start:offset,end:regionEnd});cursor+=46+nameLength+extraLength+commentLength;
  }
  if(cursor!==end)return fail('ZIP_DIRECTORY_INVALID');regions.sort((a,b)=>a.start-b.start);
  if(regions[0].start!==0||regions.at(-1)!.end!==directory||regions.some((region,index)=>index>0&&regions[index-1].end!==region.start))return fail('ZIP_LAYOUT_INVALID');
  return documents;
}

/** Compatibility inspection entry point retains metadata only. */
export function inspectAlipayStatementArchive(input:Uint8Array):AlipayStatementDocument[]{
  return readAlipayStatementArchive(input).map(item=>item.document);
}
