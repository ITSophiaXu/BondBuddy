import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectAlipayStatementArchive,alipayArchiveCrc32,ALIPAY_STATEMENT_ARCHIVE_LIMIT,AlipayArchiveError} from './alipay-statements-archive.js';
import {syntheticStatementZip,syntheticCsv} from './alipay-statements-fixtures.js';
const rejected=(bytes:Uint8Array,code?:string)=>assert.throws(()=>inspectAlipayStatementArchive(bytes),(error:unknown)=>error instanceof AlipayArchiveError&&(!code||error.code===code));

test('bounded ZIP inspection supports stored/deflated CSV and descriptors without normalizing business rows',()=>{
  const bytes=syntheticCsv(),hash=createHash('sha256').update(bytes).digest('hex');
  assert.equal(alipayArchiveCrc32(Buffer.from('123456789')),0xcbf43926);
  for(const method of [0,8])for(const descriptor of [false,true]){
    const documents=inspectAlipayStatementArchive(syntheticStatementZip([{bytes,method,descriptor}]));
    assert.equal(documents.length,1);assert.equal(documents[0].sha256,hash);assert.equal(documents[0].encoding,'utf-8');assert.equal(documents[0].byteLength,bytes.length);
    assert.equal('name' in documents[0],false);assert.equal('text' in documents[0],false);
  }
});

test('strict encoding accepts explicit UTF-8 BOM, ASCII, and unambiguous GBK; invalid/ambiguous bytes stay unknown',()=>{
  assert.equal(inspectAlipayStatementArchive(syntheticStatementZip([{bytes:Buffer.from('field,value\nsynthetic,unverified\n')}]))[0].encoding,'utf-8');
  assert.equal(inspectAlipayStatementArchive(syntheticStatementZip([{bytes:Buffer.from([0xc4,0xe3,0xba,0xc3,0x0a])}]))[0].encoding,'gbk');
  rejected(syntheticStatementZip([{bytes:Buffer.from([0xef,0xbb,0xbf,0xff])}]),'CSV_ENCODING_INVALID');
  rejected(syntheticStatementZip([{bytes:Buffer.from([0x81])}]),'CSV_ENCODING_INVALID');
  rejected(syntheticStatementZip([{bytes:Buffer.from('中文')}]),'CSV_ENCODING_AMBIGUOUS');
  rejected(syntheticStatementZip([{bytes:Buffer.from('x\0y')}]),'CSV_TEXT_INVALID');
  rejected(syntheticStatementZip([{bytes:Buffer.from('\ufeffx\ufffdy')}]),'CSV_TEXT_INVALID');
});

test('ZIP filenames cannot introduce paths, duplicate names, executables, directories, or symlinks',()=>{
  for(const name of ['../synthetic.csv','folder/synthetic.csv','folder\\synthetic.csv','C:synthetic.csv','synthetic.exe','synthetic.csv\0'])rejected(syntheticStatementZip([{name}]),'ZIP_NAME_INVALID');
  rejected(syntheticStatementZip([{name:'Synthetic.csv'},{name:'synthetic.csv'}]),'ZIP_DUPLICATE_NAME');
  rejected(syntheticStatementZip([{attributes:0x10}]),'ZIP_ENTRY_UNSUPPORTED');
  rejected(syntheticStatementZip([{madeBy:3<<8|20,attributes:(0xa000<<16)>>>0}]),'ZIP_ENTRY_UNSUPPORTED');
});

test('ZIP encryption, unsupported methods and inconsistent local metadata are rejected',()=>{
  rejected(syntheticStatementZip([{flags:0x801}]),'ZIP_ENTRY_UNSUPPORTED');
  rejected(syntheticStatementZip([{method:9}]),'ZIP_ENTRY_UNSUPPORTED');
  const mismatch=syntheticStatementZip();mismatch.writeUInt16LE(8,8);rejected(mismatch,'ZIP_LOCAL_MISMATCH');
  const descriptor=syntheticStatementZip([{descriptor:true}]),end=descriptor.length-22,directory=descriptor.readUInt32LE(end+16);descriptor.writeUInt32LE(0,directory-12);rejected(descriptor,'ZIP_DESCRIPTOR_INVALID');
});

test('CRC, compressed stream, central-directory boundaries and overlapping entries are checked',()=>{
  const corrupted=syntheticStatementZip();corrupted[30+corrupted.readUInt16LE(26)]^=1;rejected(corrupted,'ZIP_CONTENT_MISMATCH');
  const deflated=syntheticStatementZip([{method:8}]);deflated.fill(0xff,30+deflated.readUInt16LE(26),30+deflated.readUInt16LE(26)+5);rejected(deflated);
  const trailing=Buffer.concat([syntheticStatementZip(),Buffer.from('untracked')]);rejected(trailing,'ZIP_DIRECTORY_INVALID');
  const overlapping=syntheticStatementZip([{name:'one.csv'},{name:'two.csv'}]),directory=overlapping.readUInt32LE(overlapping.length-6),second=directory+46+Buffer.byteLength('one.csv');overlapping.writeUInt32LE(0,second+42);rejected(overlapping);
  const badDirectory=syntheticStatementZip();badDirectory.writeUInt32LE(0,badDirectory.length-6);rejected(badDirectory,'ZIP_DIRECTORY_INVALID');
});

test('archive, entry-count, expanded-size and expansion-ratio budgets fail closed',()=>{
  rejected(Buffer.alloc(ALIPAY_STATEMENT_ARCHIVE_LIMIT+1),'ZIP_SIZE_INVALID');
  rejected(syntheticStatementZip([]),'ZIP_DIRECTORY_INVALID');
  rejected(syntheticStatementZip(Array.from({length:9},(_,i)=>({name:`${i}.csv`}))),'ZIP_DIRECTORY_INVALID');
  rejected(syntheticStatementZip([{method:8,bytes:Buffer.from('A'.repeat(100000))}]),'ZIP_ENTRY_UNSUPPORTED');
  const tooLarge=syntheticStatementZip(),directory=tooLarge.readUInt32LE(tooLarge.length-6);tooLarge.writeUInt32LE(10*1024*1024+1,directory+24);rejected(tooLarge,'ZIP_ENTRY_UNSUPPORTED');
});

test('unknown content remains unnormalized metadata; control characters and oversized text are rejected',()=>{
  const documents=inspectAlipayStatementArchive(syntheticStatementZip([{bytes:Buffer.from('not,an,official,header\nno,financial,meaning,claimed\n')}]))[0];
  assert.equal(documents.lineCount,3);assert.equal('entries' in documents,false);
  rejected(syntheticStatementZip([{bytes:Buffer.from('x\ry')}]),'CSV_TEXT_LIMIT');
  rejected(syntheticStatementZip([{bytes:Buffer.from('x'.repeat(32769))}]),'CSV_TEXT_LIMIT');
});

test('CSV line limits reject a near-limit stored archive of newlines without allocating a line array',()=>{
  const maximum=inspectAlipayStatementArchive(syntheticStatementZip([{method:0,bytes:Buffer.alloc(100001,10)}]));
  assert.equal(maximum[0].lineCount,100002);
  rejected(syntheticStatementZip([{method:0,bytes:Buffer.alloc(100002,10)}]),'CSV_TEXT_LIMIT');
  const worst=syntheticStatementZip([{method:0,bytes:Buffer.alloc(ALIPAY_STATEMENT_ARCHIVE_LIMIT-1024,10)}]);
  assert.ok(worst.length<ALIPAY_STATEMENT_ARCHIVE_LIMIT);assert.equal(worst.readUInt16LE(8),0);
  rejected(worst,'CSV_TEXT_LIMIT');
  assert.equal(inspectAlipayStatementArchive(syntheticStatementZip([{method:0,bytes:Buffer.from('a\r\nb\n')}]))[0].lineCount,3);
  assert.equal(inspectAlipayStatementArchive(syntheticStatementZip([{method:0,bytes:Buffer.from('x'.repeat(32768))}]))[0].lineCount,1);
  const utf16Boundary='\ufeff'+'😀'.repeat(16384);
  assert.equal(inspectAlipayStatementArchive(syntheticStatementZip([{method:0,bytes:Buffer.from(utf16Boundary)}]))[0].lineCount,1);
  rejected(syntheticStatementZip([{method:0,bytes:Buffer.from(utf16Boundary+'😀')}]),'CSV_TEXT_LIMIT');
});
