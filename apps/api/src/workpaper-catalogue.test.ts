import test from 'node:test';
import assert from 'node:assert/strict';
import {ZipFile} from 'yazl';
import {parseCatalogueRows,parseWorkpaperXlsx,previewCatalogueRows} from './workpaper-catalogue.js';
import {workpaperPathPart,WORKPAPER_LIMITS} from '@bondbuddy/contracts';
export async function catalogueXlsx(rows:number=500,extra='',numericEntities?:'decimal'|'hex'){
  const zip=new ZipFile(),chunks:Buffer[]=[];
  const complete=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',c=>chunks.push(c));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);});
  const parts:Record<string,string>={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="底稿目录" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    'xl/sharedStrings.xml':'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>底稿名称</t></si></sst>',
    'xl/worksheets/sheet1.xml':`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>编号</t></is></c><c r="B1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>分类</t></is></c></row>${Array.from({length:rows},(_,i)=>`<row r="${i+2}"><c r="A${i+2}"><v>${i+1}</v></c><c r="B${i+2}" t="inlineStr"><is><t>财务核查 ${i+1}</t></is></c>${i===0?'<c r="C2" t="inlineStr"><is><t>财务资料</t></is></c>':''}</row>`).join('')}${extra}</sheetData><mergeCells><mergeCell ref="C2:C${rows+1}"/></mergeCells></worksheet>`};
  for(const [name,text] of Object.entries(parts))zip.addBuffer(Buffer.from(numericEntities?text.replace(/[^\x00-\x7f]/gu,c=>numericEntities==='hex'?'&#x'+c.codePointAt(0)!.toString(16)+';':'&#'+c.codePointAt(0)+';'):text),name,{compress:true});zip.end();return complete;
}

test('headerless numbered due-diligence lists retain the first item and summary rows',()=>{
  const parsed=parseCatalogueRows([{name:'目录',rows:[
    {row:1,cells:['合成公司私募债券尽调清单']},
    {row:2,cells:['1','发行人基本情况调查']},
    {row:3,cells:['1-1','历史沿革和股权结构']},
    {row:4,cells:['1-1-1','发行人工商信息相关文件']},
    {row:5,cells:['2','业务调查']},
    {row:6,cells:['2-1','主要业务情况']},
  ]}]);
  assert.deepEqual(parsed.entries.map(e=>[e.code,e.title,e.row]),[
    ['1','发行人基本情况调查',2],['1-1','历史沿革和股权结构',3],
    ['1-1-1','发行人工商信息相关文件',4],['2','业务调查',5],['2-1','主要业务情况',6],
  ]);
  assert.ok(parsed.entries.every(e=>e.kind==='file'));
  assert.ok(parsed.warnings.some(w=>w.includes('未设置表头')));
});

test('uncertain and competing layouts require review rather than guessing silently',()=>{
  assert.equal(previewCatalogueRows([{name:'说明',rows:[{row:1,cells:['2026','年度说明']},{row:2,cells:['其他说明']}]}]).needs_review,true);
  assert.equal(previewCatalogueRows([{name:'说明',rows:[{row:1,cells:['1','只有一条不明确的说明']}]}]).needs_review,true);
  assert.equal(previewCatalogueRows([{name:'并列',rows:[{row:1,cells:['1','左侧','1','右侧']},{row:2,cells:['2','左侧二','2','右侧二']}]}]).needs_review,true);
  const parsed=parseCatalogueRows([{name:'目录',rows:[{row:1,cells:['','','合成清单']},{row:2,cells:['','1.1','营业执照']},{row:3,cells:['','1.2','公司章程']}]}]);
  assert.deepEqual(parsed.entries.map(e=>e.code),['1.1','1.2']);
});

for(const encoding of ['decimal','hex'] as const)test(`Chinese XML ${encoding} references preserve catalogue headers, cells and sheet names`,async()=>{
  const parsed=parseWorkpaperXlsx(await catalogueXlsx(1,'<row r="3"><c r="B3" t="inlineStr"><is><t>&amp;#24213;</t></is></c></row>',encoding));
  assert.equal(parsed.entries.length,2);
  assert.equal(parsed.entries[0]!.title,'财务核查 1');
  assert.equal(parsed.entries[0]!.sheet,'底稿目录');
  assert.equal(parsed.entries[0]!.folder,'财务资料');
  assert.equal(parsed.entries[1]!.title,'&#24213;');
});
test('500 real XLSX rows, shared strings and merged classification cells retain exact ordering',async()=>{
  const parsed=parseWorkpaperXlsx(await catalogueXlsx());assert.equal(parsed.entries.length,500);
  assert.equal(parsed.entries[0]!.title,'财务核查 1');assert.equal(parsed.entries[499]!.code,'500');
  assert.ok(parsed.entries.every(e=>e.folder==='财务资料'));assert.equal(parsed.warnings.length,0);
});
test('directories, duplicate paths, unsafe characters and multiple worksheets',()=>{
  const p=parseCatalogueRows([{name:'测试',rows:[{row:1,cells:['编号','文件名称','类型']},{row:2,cells:['1','主体情况','目录']},
    {row:3,cells:['1.1','营业执照']},{row:4,cells:['1.2','../核查<>']},{row:5,cells:['1.2','../核查<>']}]},
    {name:'说明',rows:[{row:1,cells:['使用说明']}] }]);
  assert.equal(p.entries.filter(e=>e.kind==='file').length,3);assert.equal(p.entries[1]!.folder,'测试/1 主体情况');
  assert.notEqual(p.entries[2]!.path,p.entries[3]!.path);assert.ok(p.warnings.some(w=>w.includes('重名')));assert.ok(p.warnings.some(w=>w.includes('已跳过')));
  for(const entry of p.entries)assert.ok(!entry.path.split('/').includes('..'));
  assert.equal(workpaperPathPart('CON'),'_CON');
});
test('formula titles are never executed or treated as cached facts',async()=>{
  const p=parseWorkpaperXlsx(await catalogueXlsx(1,'<row r="3"><c r="B3"><f>HYPERLINK("https://example.invalid","secret")</f><v>cached title</v></c></row>'));
  assert.equal(p.entries.length,1);assert.match(p.warnings[0]!,/公式/);
});
test('unnumbered directory groups retain following files; duplicate row IDs are rejected',async()=>{
  const parsed=parseCatalogueRows([{name:'目录',rows:[{row:1,cells:['文件名称','类型']},{row:2,cells:['主体资料','目录']},
    {row:3,cells:['营业执照','文件']},{row:4,cells:['财务资料','目录']},{row:5,cells:['审计报告','文件']}]}]);
  assert.equal(parsed.entries[1]!.folder,'主体资料');assert.equal(parsed.entries[3]!.folder,'财务资料');
  assert.throws(()=>parseWorkpaperXlsx(Buffer.alloc(WORKPAPER_LIMITS.fileBytes+1)),/10 MB/);
  const duplicate=await catalogueXlsx(1,'<row r="2"><c r="B2" t="inlineStr"><is><t>重复底稿</t></is></c></row>');
  assert.throws(()=>parseWorkpaperXlsx(duplicate),/重复行号/);
});
test('empty, oversized catalogues and malformed ZIP fail explicitly',async()=>{
  assert.throws(()=>parseCatalogueRows([{name:'x',rows:[{row:1,cells:['wrong']}]}]));
  assert.throws(()=>parseCatalogueRows([{name:'x',rows:[{row:1,cells:['文件名称']},...Array.from({length:WORKPAPER_LIMITS.items+1},(_,i)=>({row:i+2,cells:['底稿']}))]}]),/1,000/);
  assert.throws(()=>parseWorkpaperXlsx(Buffer.alloc(30)));
  const bytes=await catalogueXlsx(2);bytes[40]^=1;assert.throws(()=>parseWorkpaperXlsx(bytes));
});


test('audit checklist 项目 headers and numbered summary records are retained',()=>{
  const parsed=parseCatalogueRows([{name:'1 尽职调查文件',rows:[{row:8,cells:['序号','项    目 ']},{row:9,cells:['1','发行人基本情况调查']},{row:10,cells:['1-0','发行人基本情况核查记录']},{row:11,cells:['1-1','历史沿革与股权结构']},{row:12,cells:['1-1-1','批准（备案）文件（如有）']}]}]);
  assert.deepEqual(parsed.entries.filter(e=>e.kind==='file').map(e=>e.code),['1','1-0','1-1','1-1-1']);
  assert.match(parsed.entries.at(-1)!.path,/批准或备案文件\.docx$/);
  assert.match(parsed.entries.at(-1)!.title,/如有/);
});
