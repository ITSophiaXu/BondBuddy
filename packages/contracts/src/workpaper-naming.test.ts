import test from 'node:test';
import assert from 'node:assert/strict';
import {workpaperFilenameTitle,workpaperDownloadFilename,workpaperRelativePath,workpaperZipPath,WORKPAPER_ZIP_PATH_BYTES} from './workpaper-naming.js';

test('catalogue annotations are removed with their contents, including nested Chinese and ASCII parentheses',()=>{
  for(const title of [
    '资产说明（包括受限资产明细、原因和偿债影响）',
    '资产说明(含明细和原因)',
    '资产说明（如有(包括明细（超过30%）)）',
    '资产说明(如需（签字日期）)',
    '资产说明（举例、操作要求）',
    '资产说明（尚未闭合的操作要求',
  ])assert.equal(workpaperFilenameTitle(title),'资产说明');
  assert.equal(workpaperFilenameTitle('（包括整段编制要求）'),'底稿');
});

test('legal entity qualifiers and the approved filing document type survive',()=>{
  assert.equal(workpaperFilenameTitle('甲（中国）有限公司核查记录（包括签章）'),'甲（中国）有限公司核查记录');
  assert.equal(workpaperFilenameTitle('Alpha (China)有限公司说明（如有）'),'Alpha (China)有限公司说明');
  assert.equal(workpaperFilenameTitle('甲（集团）公司说明（含附表）'),'甲（集团）公司说明');
  assert.equal(workpaperFilenameTitle('Alpha (China) Ltd 说明（如有）'),'Alpha (China) Ltd 说明');
  assert.equal(workpaperFilenameTitle('批准（备案）文件（含相关证明）'),'批准或备案文件');
});

test('downloads of a retained batch recover the original title instead of reusing a flattened legacy path',()=>{
  const entry={code:'2-4-5',title:'受限资产说明（包括明细、原因、状态及偿债影响）及核查记录',folder:'',path:'2-4-5 受限资产说明及明细、原因、状态及偿债影响及核查记录.docx'};
  const before=JSON.stringify(entry);
  assert.equal(workpaperDownloadFilename(entry),'2-4-5 受限资产说明及核查记录.docx');
  assert.equal(workpaperDownloadFilename(entry,{explanation:true}),'2-4-5 受限资产说明及核查记录-不适用说明.docx');
  assert.equal(JSON.stringify(entry),before);
});

test('long Chinese paths stay within the Windows byte limit, including folders, category and explanation suffix',()=>{
  const used=new Set<string>();
  for(const explanation of [false,true])for(const title of ['治理机构设置说明。'+'补充要求'.repeat(70),'受限资产情况'.repeat(50)+'核查记录','😀𠮷'.repeat(100)+'分析文件']){
    const entry={code:'1-5-2',title,folder:'第一层（含指引）/第二层'.repeat(20)};
    const path=workpaperZipPath(entry,explanation,used);
    assert.ok(Buffer.byteLength(path)<=WORKPAPER_ZIP_PATH_BYTES,path);
    assert.ok(path.includes('/1-5-2 '));assert.ok(path.endsWith(explanation?'-不适用说明.docx':'.docx'));
    assert.ok(!path.includes('补充要求'));assert.ok(!path.includes('�'));
    assert.ok(!/[<>:"\\|?*\u0000-\u001f]/u.test(path));
  }
  assert.equal(workpaperDownloadFilename({code:'1-5-2',title:'治理机构设置说明。'+'补充要求'.repeat(70)}),'1-5-2 治理机构设置说明.docx');
});

test('all documents survive collisions after annotation removal or length shortening',()=>{
  const used=new Set<string>(),names=[];
  for(let i=0;i<1000;i++)names.push(workpaperZipPath({code:'1-1',title:'同名文件（含示例'+i+'）'},false,used));
  assert.equal(new Set(names).size,1000);assert.equal(names[0],'可生成文件/1-1 同名文件.docx');
  assert.equal(names[999],'可生成文件/1-1 同名文件 (1000).docx');
  assert.ok(names.every(n=>Buffer.byteLength(n)<=WORKPAPER_ZIP_PATH_BYTES));
  const longUsed=new Set<string>();
  const paths=['一','二'].map(end=>workpaperZipPath({code:'2-1',title:'财务情况'.repeat(80)+end+'核查记录'},true,longUsed));
  assert.notEqual(paths[0],paths[1]);assert.ok(paths.every(n=>Buffer.byteLength(n)<=WORKPAPER_ZIP_PATH_BYTES));
});

test('reserved names, traversal components and duplicate import suffixes stay safe',()=>{
  assert.equal(workpaperRelativePath({code:'',title:'CON',folder:'../NUL'}),'未命名/_NUL/_CON.docx');
  assert.equal(workpaperDownloadFilename({code:'1',title:'说明（含附件）',path:'1 说明 (2).docx'}),'1 说明 (2).docx');
  assert.throws(()=>workpaperDownloadFilename({code:'一'.repeat(100),title:'资产说明'}),/编号过长/);
});
