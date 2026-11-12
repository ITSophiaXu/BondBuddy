import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {ARTIFACT_INSPECTION_VERSION,validateDownload,assertCaseArtifacts,createExpectedWorkpapers} from './artifacts.mjs';
import {inspectDocxParts,inspectArtifactBytes} from './artifact-inspect-cli.mjs';

const {SaxesParser}=createRequire(import.meta.url)('saxes');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const word='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const office='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels='http://schemas.openxmlformats.org/package/2006/relationships';
const types='http://schemas.openxmlformats.org/package/2006/content-types';
function docxParts({text='Synthetic release document',document,extra=[]}={}){
 return new Map([
  ['[Content_Types].xml',`<Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
  ['_rels/.rels',`<Relationships xmlns="${rels}"><Relationship Id="main" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`],
  ['word/document.xml',document??`<w:document xmlns:w="${word}" xmlns:r="${office}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ...extra,
 ].map(([name,value])=>[name,Buffer.from(value)]));
}
const inspectParts=parts=>inspectDocxParts(parts,{SaxesParser});

test('streaming OOXML inspection handles a legitimate document above the legacy 8 MiB DOM ceiling',()=>{
 const text='x'.repeat(8*1024*1024+100),result=inspectParts(docxParts({text}));
 assert.equal(result.status,'passed');assert.equal(result.bodyCharacters,text.length);
 assert.ok(Object.values(result.checks).every(value=>value==='passed'));
});

test('all XML parts, namespaces, actual body text and DTD restrictions are checked',()=>{
 assert.equal(inspectParts(docxParts()).status,'passed');
 for(const [parts,code] of [
  [docxParts({text:'  \n '}),'DOCX_WORD_DOCUMENT_EMPTY'],
  [docxParts({document:`<w:document xmlns:w="${word}"><w:body><w:p><w:del><w:r><w:t>deleted</w:t></w:r></w:del></w:p></w:body></w:document>`}),'DOCX_WORD_DOCUMENT_EMPTY'],
  [docxParts({document:`<w:document xmlns:w="${word}"><w:body xmlns:w="urn:wrong"><w:p/></w:body></w:document>`}),'DOCX_WORD_DOCUMENT_INVALID'],
  [docxParts({document:`<!DOCTYPE w:document [<!ENTITY secret "x">]><w:document xmlns:w="${word}"><w:body><w:p><w:t>&secret;</w:t></w:p></w:body></w:document>`}),'DOCX_XML_DTD_FORBIDDEN'],
  [docxParts({extra:[['word/unused.xml','<invalid>']]}),'DOCX_XML_MALFORMED'],
  [docxParts({extra:[['word/unused.xml',Buffer.from([0xff])]]}),'DOCX_XML_ENCODING_INVALID'],
 ])assert.throws(()=>inspectParts(parts),new RegExp(code));
});

test('relationships require every source, internal target and referenced id with allowed external protocols',()=>{
 const base=docxParts({document:`<w:document xmlns:w="${word}" xmlns:r="${office}"><w:body><w:p><w:hyperlink r:id="link"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`,extra:[
  ['word/_rels/document.xml.rels',`<Relationships xmlns="${rels}"><Relationship Id="link" Type="${office}/hyperlink" Target="https://example.invalid/synthetic" TargetMode="External"/></Relationships>`],
 ]});
 assert.equal(inspectParts(base).relationshipCount,2);
 const without=new Map(base);without.delete('word/_rels/document.xml.rels');assert.throws(()=>inspectParts(without),/REFERENCE_MISSING/);
 for(const [value,code] of [
  [`<Relationships xmlns="${rels}"><Relationship Id="link" Type="${office}/image" Target="missing.png"/></Relationships>`,'TARGET_MISSING'],
  [`<Relationships xmlns="${rels}"><Relationship Id="link" Type="${office}/image" Target="../../escape"/></Relationships>`,'TARGET_INVALID'],
  [`<Relationships xmlns="${rels}"><Relationship Id="link" Type="${office}/hyperlink" Target="file:///etc/passwd" TargetMode="External"/></Relationships>`,'TARGET_INVALID'],
  [`<Relationships xmlns="${rels}"><Relationship Id="link" Type="${office}/image" Target="https://example.invalid/image" TargetMode="External"/></Relationships>`,'EXTERNAL_RELATIONSHIP_FORBIDDEN'],
  [`<Relationships xmlns="${rels}"><Relationship xmlns="urn:wrong" Id="link" Type="${office}/image" Target="document.xml"/></Relationships>`,'RELATIONSHIPS_INVALID'],
 ]){const changed=new Map(base);changed.set('word/_rels/document.xml.rels',Buffer.from(value));assert.throws(()=>inspectParts(changed),new RegExp(code));}
 const orphan=new Map(base);orphan.set('word/_rels/missing.xml.rels',Buffer.from(`<Relationships xmlns="${rels}"/>`));assert.throws(()=>inspectParts(orphan),/SOURCE_MISSING/);
});

test('content types account for every file and override and refuse macro documents',()=>{
 for(const [mutate,code] of [
  [parts=>parts.delete('[Content_Types].xml'),'REQUIRED_PART_MISSING'],
  [parts=>parts.set('[Content_Types].xml',Buffer.from(parts.get('[Content_Types].xml').toString().replace('</Types>','unexpected text</Types>'))),'XML_STRUCTURE_INVALID'],
  [parts=>parts.set('word/media/image.bin',Buffer.from('synthetic')),'PART_CONTENT_TYPE_MISSING'],
  [parts=>parts.set('[Content_Types].xml',Buffer.from(parts.get('[Content_Types].xml').toString().replace('</Types>','<Override PartName="/missing.xml" ContentType="application/xml"/></Types>'))),'CONTENT_TYPE_TARGET_MISSING'],
  [parts=>parts.set('[Content_Types].xml',Buffer.from(parts.get('[Content_Types].xml').toString().replace('wordprocessingml.document.main+xml','ms-word.document.macroEnabled.main+xml'))),'MACROS_FORBIDDEN'],
 ]){const parts=docxParts();mutate(parts);assert.throws(()=>inspectParts(parts),new RegExp(code));}
});

function bundleFixture(){
 const outer=Buffer.from('synthetic outer ZIP'),parts=new Map(),registry=new Map(),expected=[];
 for(let i=0;i<5;i++){
  const content=Buffer.from('synthetic DOCX '+i),disposition=i<3?'generated':'explanation',folder=i<3?'可生成文件':'不适用说明';
  const archivePath=`${folder}/1 尽职调查文件/1-${i+1} 合成文件.docx`;
  parts.set(archivePath,content);registry.set(content.toString(),docxParts());
  expected.push({entryId:'item-'+i,cataloguePath:'1 尽职调查文件/'+i,disposition,decisionStatus:i<3?'generate':'missing_information',archivePath,sha256:hash(content)});
 }
 const deps={SaxesParser,readBoundedZipParts:(bytes,include,streaming)=>{
  assert.equal(streaming,true);assert.equal(include('any.xml'),true);
  return bytes===outer?parts:registry.get(bytes.toString())??fail();
 }};
 function fail(){throw Error('DOCX_ZIP_INVALID');}
 return {outer,parts,registry,expected,deps,request:{kind:'workpaper_zip',expectedBytes:outer.length,expectedSha256:hash(outer),expectedWorkpapers:expected}};
}
test('five-item ZIP checks every ordinary file, trusted hash and every DOCX against both folders',()=>{
 const f=bundleFixture(),result=inspectArtifactBytes(f.outer,f.request,f.deps);
 assert.equal(result.status,'passed');assert.equal(result.regularFiles,5);assert.equal(result.members.length,5);
 f.registry.set('synthetic DOCX 4',docxParts({extra:[['word/unused.xml','broken']]}));
 const bad=inspectArtifactBytes(f.outer,f.request,f.deps);assert.equal(bad.status,'failed');assert.deepEqual(bad.failureCodes,['DOCX_XML_MALFORMED']);
});
test('ZIP missing, extra, duplicate, unsafe, unpinned and mismatched members fail closed',()=>{
 for(const mutate of [
  f=>f.parts.delete(f.expected[0].archivePath),
  f=>f.parts.set('unreviewed.txt',Buffer.from('extra')),
  f=>f.expected[4].entryId=f.expected[0].entryId,
  f=>f.expected[0].archivePath='可生成文件/../escape.docx',
  f=>f.expected[0].sha256='0'.repeat(64),
  f=>f.request.expectedWorkpapers=f.expected.slice(0,4),
  f=>f.expected.forEach(item=>{item.disposition='generated';item.decisionStatus='generate';item.archivePath=item.archivePath.replace('不适用说明','可生成文件');}),
 ]){const f=bundleFixture();mutate(f);assert.equal(inspectArtifactBytes(f.outer,f.request,f.deps).status,'failed');}
});
test('CRC and bounded ZIP failures are never replaced with a PK-header success',()=>{
 const bytes=Buffer.from('PK synthetic corrupt bytes');
 for(const code of ['DOCX_CRC_MISMATCH','DOCX_PART_SIZE_LIMIT','DOCX_DEFLATE_TRAILING_DATA','DOCX_UNSAFE_PART_TYPE']){
  const result=inspectArtifactBytes(bytes,{kind:'docx',expectedSha256:hash(bytes),expectedBytes:bytes.length},{readBoundedZipParts:()=>{throw Error(code);},SaxesParser});
  assert.equal(result.status,'failed');assert.deepEqual(result.failureCodes,[code]);
 }
});

function batchFixture(){
 return {batch_id:'batch',items:Array.from({length:5},(_,i)=>({entry:{id:'item-'+i,path:'1 尽职调查文件/'+i+'.docx'},state:'succeeded',
  decision:{status:i<3?'generate':'external_evidence'},artifacts:i<3?[{kind:'document',pin:{sha256:hash(Buffer.from('document '+i))}}]:[],
  ...(i<3?{}:{explanation:{sha256:hash(Buffer.from('explanation '+i))}})}))};
}
test('expected ZIP mapping follows authoritative explanation-first API ordering without reclassifying missing evidence',()=>{
 const calls=[],naming=(entry,explanation,used)=>{calls.push([entry.id,explanation,used.size]);used.add(entry.id);return `${explanation?'不适用说明':'可生成文件'}/${entry.path}`;};
 const expected=createExpectedWorkpapers(batchFixture(),{workpaperZipPath:naming});
 assert.deepEqual(expected.map(x=>x.entryId),['item-3','item-4','item-0','item-1','item-2']);
 assert.equal(expected[0].decisionStatus,'external_evidence');assert.equal(expected[0].disposition,'explanation');
 assert.deepEqual(calls.map(x=>x[2]),[0,1,2,3,4]);
 for(const mutate of [b=>b.items.pop(),b=>b.items[0].state='running',b=>b.items[0].entry.id=b.items[1].entry.id,
  b=>b.items[0].artifacts.push(b.items[0].artifacts[0]),b=>b.items[0].explanation={sha256:'f'.repeat(64)},b=>b.items[4].explanation.sha256='bad']){
  const batch=batchFixture();mutate(batch);assert.throws(()=>createExpectedWorkpapers(batch,{workpaperZipPath:naming}));
 }
});

function downloadFixture(t){
 const root=mkdtempSync(join(tmpdir(),'bb-release-artifact-test-'));
 const relativePath=relative(tmpdir(),root);assert.ok(relativePath.startsWith('bb-release-artifact-test-')&&!relativePath.includes('..'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('synthetic bytes'),path=join(root,'artifact.docx');writeFileSync(path,bytes);
 const result={schema:ARTIFACT_INSPECTION_VERSION,kind:'docx',bytes:bytes.length,sha256:hash(bytes),...inspectParts(docxParts())};
 const download={role:'tracked.docx',path,bytes:bytes.length,sha256:hash(bytes),filename:'synthetic.docx'};
 return {bytes,path,result,download,inspect:async()=>structuredClone(result)};
}
test('every downloaded role is inspected and duplicate roles cannot stand in for the clean document',async t=>{
 const f=downloadFixture(t),required=[{name:'tracked.docx',kind:'docx'},{name:'clean.docx',kind:'docx'}];let calls=0;
 const entry={downloads:[f.download,{...f.download},{...f.download,role:'clean.docx'}]};
 const result=await assertCaseArtifacts(entry,{required,inspect:async()=>{calls++;return f.inspect();}});
 assert.equal(result.status,'passed');assert.equal(calls,3);
 await assert.rejects(assertCaseArtifacts({downloads:entry.downloads.slice(0,2)},{required,inspect:f.inspect}),/ROLE_MISSING/);
 await assert.rejects(assertCaseArtifacts({downloads:[f.download,{...f.download,sha256:'f'.repeat(64)}]},{required,inspect:f.inspect}),/REDOWNLOAD_MISMATCH/);
 await assert.rejects(assertCaseArtifacts({downloads:[{...f.download,role:'unknown'}]},{required,inspect:f.inspect}),/ROLE_UNEXPECTED/);
});
test('file hashes, callback completeness and file immutability are mandatory',async t=>{
 const f=downloadFixture(t),request={path:f.path,kind:'docx',expectedSha256:f.download.sha256,expectedBytes:f.bytes.length};
 await assert.rejects(validateDownload({...request,expectedSha256:'0'.repeat(64)},{inspect:f.inspect}),/HASH_MISMATCH/);
 await assert.rejects(validateDownload(request,{inspect:async()=>({...f.result,checks:{zip_structure:'passed'}})}),/STRUCTURE_INCOMPLETE/);
 await assert.rejects(validateDownload(request,{inspect:async()=>({...f.result,bodyCharacters:0})}),/STRUCTURE_INCOMPLETE/);
 await assert.rejects(validateDownload(request,{inspect:async()=>{writeFileSync(f.path,Buffer.alloc(f.bytes.length));return f.result;}}),/CHANGED_DURING_INSPECTION/);
});
