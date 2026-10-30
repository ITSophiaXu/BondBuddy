import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCatalogueRows,previewCatalogueRows,type CatalogueSheet} from './workpaper-catalogue.js';
const sheet=(cells:string[][],name='目录'):CatalogueSheet=>({name,rows:cells.map((cells,i)=>({row:i+1,cells}))});

test('nonadjacent code/name columns and different numbering conventions are inferred from values',()=>{
  const p=previewCatalogueRows([sheet([['目录清单'],['A01','','营业执照'],['A02','','章程'],['（三）','','组织结构']])]);
  assert.equal(p.needs_review,false);assert.deepEqual(p.entries.map(e=>[e.code,e.title,e.row]),[['A01','营业执照',2],['A02','章程',3],['（三）','组织结构',4]]);
});
test('single-cell numbering is split conservatively and can be disabled',()=>{
  const s=sheet([['1-1 营业执照'],['1.2 公司章程'],['（三）组织架构']]),p=previewCatalogueRows([s]);
  assert.equal(p.needs_review,false);assert.deepEqual(p.entries.map(e=>[e.code,e.title]),[['1-1','营业执照'],['1.2','公司章程'],['（三）','组织架构']]);
  const literal=parseCatalogueRows([s],[{...p.mapping[0]!,split_code:false}]);assert.equal(literal.entries[0]!.title,'1-1 营业执照');
});
test('plain lists without any header or numbering are reviewable and import after selection',()=>{
  const s=sheet([['公司资料清单'],['营业执照'],['公司章程']]),p=previewCatalogueRows([s]);
  assert.equal(p.needs_review,true);assert.equal(p.entries.length,3);
  const confirmed=parseCatalogueRows([s],[{...p.mapping[0]!,first_row:2}]);assert.deepEqual(confirmed.entries.map(e=>e.title),['营业执照','公司章程']);
  assert.ok(confirmed.entries.every(e=>e.code===''),'never fabricate source numbering');
});
test('unmapped populated columns and unrecognized sheets cannot be silently dropped',()=>{
  const p=previewCatalogueRows([sheet([['索引','核查事项','非标准补充列'],['1','工商信息','保留实际核查要求'],['2','公司章程','核对变更']]),sheet([['补充资料'],['证明文件']],'附页')]);
  assert.equal(p.needs_review,true);assert.ok(p.warnings.some(w=>w.includes('尚未用作')));assert.equal(p.sheets.length,2);
  const m=p.mapping.map(x=>x.sheet==='目录'?{...x,instruction_columns:[2]}:{...x,first_row:2});
  const confirmed=parseCatalogueRows([sheet([['索引','核查事项','非标准补充列'],['1','工商信息','保留实际核查要求'],['2','公司章程','核对变更']]),sheet([['补充资料'],['证明文件']],'附页')],m);
  assert.equal(confirmed.entries[0]!.instructions,'保留实际核查要求');assert.equal(confirmed.entries.length,3);
});
test('manual mappings preserve merged classification and multiple requirement columns',()=>{
  const s=sheet([['A类','','工商信息','查明期间','核对变更'],['','','公司章程','最新版本','保留原件']]);s.merges=[{column:0,start:1,end:2}];
  const p=parseCatalogueRows([s],[{sheet:'目录',first_row:1,last_row:2,title_column:2,folder_columns:[0],instruction_columns:[3,4],split_code:false}]);
  assert.ok(p.entries.every(e=>e.folder==='A类'));assert.equal(p.entries[1]!.instructions,'最新版本\n保留原件');
});
test('repeated headers, layout changes and explicit side-by-side blocks preserve distinct source cells',()=>{
  const p=previewCatalogueRows([sheet([['编号','文件名称'],['1','营业执照'],['编号','文件名称'],['2','公司章程'],['核查事项','索引'],['业务调查','3']])]);
  assert.deepEqual(p.entries.map(e=>e.code),['1','2','3']);assert.equal(p.mapping.length,2);
  const s=sheet([['1','左侧','1','右侧'],['2','左侧二','2','右侧二']]);
  const m={sheet:'目录',first_row:1,last_row:2,title_column:1,code_column:0,split_code:false,folder_columns:[],instruction_columns:[]};
  const two=parseCatalogueRows([s],[m,{...m,title_column:3,code_column:2}]);assert.equal(two.entries.length,4);assert.equal(new Set(two.entries.map(e=>e.id)).size,4);
  assert.throws(()=>parseCatalogueRows([s],[m,m]),/重叠/);
});
test('empty titles, excluded rows and overlong guessed names are visible for correction',()=>{
  const p=previewCatalogueRows([sheet([['编号','文件名称'],['1','营业执照'],['2',''],['3','章程'],['4','很长'.repeat(200)]])]);
  assert.equal(p.needs_review,true);assert.equal(p.unrecognized_count,2);assert.deepEqual(p.unrecognized_rows.map(r=>r.row),[3,5]);
  assert.ok(p.sheets[0]!.columns[1]!.sample.includes('营业执照'));
});
test('invalid mappings cannot alias columns, reference absent sheets or exceed limits',()=>{
  const s=sheet([['营业执照']]),m={sheet:'目录',first_row:1,last_row:1,title_column:0,split_code:false,folder_columns:[],instruction_columns:[]};
  assert.throws(()=>parseCatalogueRows([s],[{...m,instruction_columns:[0]}]),/同一列/);
  assert.throws(()=>parseCatalogueRows([s],[{...m,sheet:'不存在'}]),/工作表/);
  assert.throws(()=>parseCatalogueRows([s],[{...m,title_column:100}]),/范围/);
});

test('a footer or continuation in a numbered list is retained and flagged for review',()=>{
  const p=previewCatalogueRows([sheet([['1','营业执照'],['2','公司章程'],['','以上资料请提供原件']])]);
  assert.equal(p.entries.length,3);assert.equal(p.needs_review,true);assert.ok(p.warnings.some(w=>w.includes('说明行')));
});
