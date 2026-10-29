import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {posix} from 'node:path';
import {WORKPAPER_LIMITS,WorkpaperMappingsSchema,workpaperPathPart,workpaperFilenameTitle,type WorkpaperEntry,type WorkpaperColumnMapping,type WorkpaperCataloguePreview} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {aliases,header,isHeader,numberedCode,splitCode,columnLabel,detectCatalogueLayout,type CatalogueSheet} from './workpaper-catalogue-layout.js';
export type {CatalogueSheet} from './workpaper-catalogue-layout.js';
import {readBoundedOfficeParts} from './docx-inspector.js';
import {Problem} from './data.js';
const invalid=(message:string):never=>{throw new Problem(422,'VALIDATION_FAILED',message);};
const array=(v:any):any[]=>v===undefined?[]:Array.isArray(v)?v:[v];
// Excel writers may encode Chinese text as decimal or hexadecimal XML references.
const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:false,processEntities:true,htmlEntities:true});
const plain=(v:any):string=>v==null?'':typeof v==='object'?(v['#text']??(v.t!==undefined?plain(v.t):array(v.r).map(r=>plain(r.t)).join(''))):String(v);
export function parseCatalogueRows(sheets:CatalogueSheet[],mapping?:WorkpaperColumnMapping[],allowEmpty=false):{entries:WorkpaperEntry[];warnings:string[]}{
  if(sheets.reduce((n,s)=>n+s.rows.length,0)>WORKPAPER_LIMITS.rows)invalid('目录最多支持 10,000 行，请拆分后上传。');
  const inferred=mapping?undefined:detectCatalogueLayout(sheets);
  mapping??=inferred!.mapping;
  if(mapping.length&&!Value.Check(WorkpaperMappingsSchema,mapping))invalid('目录列与行范围无效，请重新核对。');
  if(sheets.reduce((n,s)=>n+s.rows.length,0)>WORKPAPER_LIMITS.rows)invalid('目录最多支持 10,000 行，请拆分后上传。');
  const entries:WorkpaperEntry[]=[],warnings:string[]=[...(inferred?.warnings??[])],usedCells=new Set<string>();
  for(const m of mapping){
    const sheet=sheets.find(s=>s.name===m.sheet);if(!sheet||m.first_row>m.last_row)invalid('目录工作表或行范围无效，请重新核对。');
    const columns=[m.title_column,m.code_column,m.kind_column,...m.folder_columns,...m.instruction_columns].filter(c=>c!==undefined);
    if(new Set(columns).size!==columns.length)invalid('同一列不能同时作为名称、编号、分类或要求。');
    const local:WorkpaperEntry[]=[];
    for(const row of sheet!.rows.filter(r=>r.row>=m.first_row&&r.row<=m.last_row)){
      const get=(col:number|undefined)=>col===undefined?'':row.cells[col]?.trim()??'';
      let title=get(m.title_column),code=get(m.code_column);
      if(!title||(aliases.title as readonly string[]).includes(header(title)))continue;
      if(m.split_code&&m.code_column===undefined){const parts=splitCode(title);if(parts){title=parts.title;code=parts.code;}}
      const cell=`${m.sheet}:${row.row}:${m.title_column}`;if(usedCells.has(cell))invalid('选择的目录区域重叠，请保留一次。');usedCells.add(cell);
      const folder=m.folder_columns.map(col=>get(col)||sheet!.merges?.filter(x=>x.column===col&&row.row>=x.start&&row.row<=x.end).map(x=>sheet!.rows.find(r=>r.row===x.start)?.cells[col]??'')[0]||'').filter(Boolean).join('/');
      const instructions=m.instruction_columns.map(get).filter(Boolean).join('\n');
      if(title.length>300||code.length>100||instructions.length>2000||folder.length>600){
        const message=`“${sheet!.name}”第 ${row.row} 行文字超过目录条目容量，请调整列或行范围。`;
        if(allowEmpty){warnings.push(message);continue;}invalid(message);
      }
      const kind=/^(目录|文件夹|章节|分类|folder)$/i.test(get(m.kind_column))?'folder':'file';
      const id=`s${sheets.indexOf(sheet!)+1}-r${row.row}`;
      local.push({id:entries.some(e=>e.id===id)?`${id}-c${m.title_column}`:id,code,title,folder,instructions,sheet:sheet!.name,row:row.row,kind,path:''});
    }
    // Numbered summary rows are deliverables too. Only an explicit 类型=目录
    // marks a folder; hierarchy alone must never silently discard a workpaper.
    const stack:WorkpaperEntry[]=[];
    for(const item of local){
      if(!item.code&&item.kind==='folder')stack.length=0;
      while(stack.length&&stack.at(-1)!.code&&!(item.code&&item.code.startsWith(stack.at(-1)!.code)&&/^[.．\-、]/.test(item.code.slice(stack.at(-1)!.code.length))))stack.pop();
      const folder=item.folder?item.folder.split(/[\\/]+/).filter(Boolean).map(workpaperPathPart):stack.map(p=>workpaperPathPart([p.code,workpaperFilenameTitle(p.title)].filter(Boolean).join(' ')));
      if(sheets.length>1)folder.unshift(workpaperPathPart(sheet!.name));
      item.folder=folder.join('/');
      if(item.folder.length>600)invalid(`“${sheet!.name}”第 ${item.row} 行保存目录过长，请缩短目录名称。`);
      item.path=[...folder,workpaperPathPart([item.code,workpaperFilenameTitle(item.title)].filter(Boolean).join(' '))+(item.kind==='file'?'.docx':'')].join('/');
      if(item.path.length>950)invalid(`“${sheet!.name}”第 ${item.row} 行目录层级过长。`);
      entries.push(item);if(item.kind==='folder')stack.push(item);
    }
  }
  const files=entries.filter(e=>e.kind==='file');
  for(const sheet of sheets)if(!mapping.some(m=>m.sheet===sheet.name)&&sheet.rows.some(r=>r.cells.some(c=>c?.trim())))warnings.push(`工作表“${sheet.name}”未纳入目录，已跳过，请核对范围。`);
  if(!files.length&&!allowEmpty)invalid('未识别到可生成文件，请在识别预览中选择名称列和条目范围，无需重新上传。');
  if(files.length>WORKPAPER_LIMITS.items)invalid('每批最多支持 1,000 份文件，请拆分目录。');
  const used=new Set<string>();
  for(const e of files){let path=e.path;let suffix=1;while(used.has(path.toLowerCase()))path=e.path.replace(/\.docx$/i,` (${++suffix}).docx`);
    if(path!==e.path)warnings.push(`“${e.sheet}”第 ${e.row} 行与其他文件重名，下载时使用“${path}”。`);e.path=path;used.add(path.toLowerCase());}
  return {entries,warnings};
}

/** Read cells only: never evaluate formulas, hyperlinks, macros or external relationships. */
function readWorkpaperXlsx(bytes:Buffer,scope:'due_diligence'|'all'='due_diligence'){
  if(bytes.length>WORKPAPER_LIMITS.fileBytes)invalid('底稿目录请控制在 10 MB 以内。');
  const parts=readBoundedOfficeParts(bytes,n=>['xl/workbook.xml','xl/_rels/workbook.xml.rels','xl/sharedStrings.xml'].includes(n)),xml=(name:string)=>{
    if(!parts.has(name))for(const [key,value] of readBoundedOfficeParts(bytes,n=>n===name))parts.set(key,value);
    if([...parts.values()].reduce((n,b)=>n+b.length,0)>32*1024*1024)invalid('所选目录展开后过大，请缩小范围。');
    const part=parts.get(name);if(!part)invalid('Excel 目录缺少必要工作表，请另存为 XLSX 后上传。');
    const text=part!.toString('utf8');if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)invalid('Excel XML 格式无效。');return parser.parse(text);
  };
  const wb=xml('xl/workbook.xml'),rels=xml('xl/_rels/workbook.xml.rels');
  const shared=parts.has('xl/sharedStrings.xml')?array(xml('xl/sharedStrings.xml').sst?.si).map(plain):[];
  const sheets=array(wb.workbook?.sheets?.sheet),warnings:string[]=[];
  if(sheets.length>WORKPAPER_LIMITS.sheets)invalid('目录最多支持 30 个工作表。');
  const result:CatalogueSheet[]=[];
  const defaultSheet=sheets.find(s=>/^1\s*尽职调查文件\s*$/.test(String(s['@_name'])));
  for(const sheet of sheets){
    if(scope==='due_diligence'&&defaultSheet&&sheet!==defaultSheet)continue;
    const name=String(sheet['@_name']??'工作表');
    if(name.length>200)invalid('工作表名称过长。');
    if(sheet['@_state']&&sheet['@_state']!=='visible'){warnings.push(`隐藏工作表“${name}”已跳过。`);continue;}
    const rel=array(rels.Relationships?.Relationship).find(r=>r['@_Id']===sheet['@_r:id']);
    if(!rel||rel['@_TargetMode']==='External')invalid('不支持外部工作表。');
    const target=String(rel['@_Target']),path=target.startsWith('/')?target.slice(1):posix.normalize(posix.join('xl',target));
    if(!/^xl\/worksheets\/[^/]+\.xml$/.test(path))invalid('工作表路径无效。');
    const data=xml(path),rows:CatalogueSheet['rows']=[],seenRows=new Set<number>();
    for(const r of array(data.worksheet?.sheetData?.row)){
      const number=Number(r['@_r']);if(!Number.isInteger(number)||number<1||number>WORKPAPER_LIMITS.rows)invalid('工作表行号超过支持范围。');
      if(seenRows.has(number))invalid('工作表包含重复行号，请另存为标准 XLSX。');seenRows.add(number);
      const cells:string[]=[];
      for(const cell of array(r.c)){
        const address=String(cell['@_r']??''),letters=address.match(/^[A-Z]+/)?.[0];if(!letters)invalid('单元格地址无效。');
        const index=[...letters!].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;if(index>99){if(warnings.length<200)warnings.push(`“${name}”${address} 超出前 100 列读取范围，未纳入目录。`);continue;}
        if(cell.f!==undefined){warnings.push(`“${name}”${address} 为公式，未作为底稿目录内容读取，请转为值后上传。`);continue;}
        cells[index]=cell['@_t']==='s'?shared[Number(cell.v)]??'':cell['@_t']==='inlineStr'?plain(cell.is):plain(cell.v);
      }
      rows.push({row:number,cells});
    }
    const merges:NonNullable<CatalogueSheet['merges']>=[];
    for(const merged of array(data.worksheet?.mergeCells?.mergeCell)){
      const match=String(merged['@_ref']).match(/^([A-Z]+)(\d+):\1(\d+)$/);if(!match)continue;
      const col=[...match[1]!].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
      merges.push({column:col,start:Number(match[2]),end:Number(match[3])});
    }
    result.push({name,rows:rows.sort((a,b)=>a.row-b.row),merges});
  }
  return {sheets:result,warnings};
}

export function previewCatalogueRows(sheets:CatalogueSheet[],mapping?:WorkpaperColumnMapping[]):Omit<WorkpaperCataloguePreview,'filename'>{
  if(sheets.reduce((n,s)=>n+s.rows.length,0)>WORKPAPER_LIMITS.rows)invalid('目录最多支持 10,000 行，请拆分后上传。');
  const inferred=detectCatalogueLayout(sheets),selected=mapping??inferred.mapping;
  const parsed=parseCatalogueRows(sheets,selected,true),unrecognized:WorkpaperCataloguePreview['unrecognized_rows']=[];
  const warnings=[...(mapping?[]:inferred.warnings),...parsed.warnings];let extraColumns=false;
  for(const sheet of sheets){
    const maps=selected.filter(m=>m.sheet===sheet.name);
    for(const row of sheet.rows){
      if(!row.cells.some(c=>c?.trim())||row.cells.filter(c=>c?.trim()).every(c=>isHeader(c)))continue;
      if(!parsed.entries.some(e=>e.sheet===sheet.name&&e.row===row.row)){
        // The one-cell document title above an identified block is metadata, not an item.
        if(maps.length&&row===sheet.rows.find(r=>r.cells.some(c=>c?.trim()))&&row.row<Math.min(...maps.map(m=>m.first_row))&&row.cells.filter(c=>c?.trim()).length===1)continue;
        unrecognized.push({sheet:sheet.name,...row});continue;
      }
      const used=new Set(maps.filter(m=>row.row>=m.first_row&&row.row<=m.last_row).flatMap(m=>[m.title_column,m.code_column,m.kind_column,...m.folder_columns,...m.instruction_columns]));
      if(row.cells.some((c,i)=>c?.trim()&&!used.has(i)))extraColumns=true;
    }
  }
  if(extraColumns)warnings.push('部分有内容的列尚未用作名称、编号、分类或要求，请核对是否需要保留。');
  const mixedCodes=selected.some(m=>{
    const items=parsed.entries.filter(e=>e.sheet===m.sheet&&e.row>=m.first_row&&e.row<=m.last_row&&e.kind==='file');
    return items.some(e=>numberedCode(e.code))&&items.some(e=>!numberedCode(e.code));
  });
  if(mixedCodes)warnings.push('部分行的编号样式不同或没有编号，已保留为文件；请核对是否包含说明行。');
  if(unrecognized.length)warnings.push(`有 ${unrecognized.length} 行未纳入目录，请核对下方原表样例和行范围。`);
  return {...parsed,warnings:[...new Set(warnings)].slice(0,200),mapping:selected,needs_review:!parsed.entries.length||inferred.needs_review||extraColumns||mixedCodes||!!unrecognized.length,
    unrecognized_count:unrecognized.length,unrecognized_rows:unrecognized.slice(0,100).map(r=>({...r,cells:r.cells.map(c=>c?.slice(0,400)??'')})),
    sheets:sheets.map(s=>({name:s.name,last_row:s.rows.at(-1)?.row??1,
      columns:Array.from({length:Math.max(1,...s.rows.map(r=>r.cells.length))},(_,index)=>({index,label:columnLabel(index),sample:s.rows.map(r=>r.cells[index]).filter(Boolean).slice(0,3).join(' / ').slice(0,120)})),
      sample_rows:s.rows.filter(r=>r.cells.some(c=>c?.trim())).slice(0,8).map(r=>({...r,cells:r.cells.map(c=>c?.slice(0,400)??'')}))})),
  };
}
export function previewWorkpaperXlsx(bytes:Buffer,scope:'due_diligence'|'all'='due_diligence',mapping?:WorkpaperColumnMapping[]){
  const read=readWorkpaperXlsx(bytes,scope),preview=previewCatalogueRows(read.sheets,mapping);
  return {...preview,needs_review:preview.needs_review||read.warnings.length>0,warnings:[...read.warnings,...preview.warnings].slice(0,200)};
}
export function parseWorkpaperXlsx(bytes:Buffer,scope:'due_diligence'|'all'='due_diligence',mapping?:WorkpaperColumnMapping[]){
  const read=readWorkpaperXlsx(bytes,scope),parsed=parseCatalogueRows(read.sheets,mapping);
  return {...parsed,warnings:[...read.warnings,...parsed.warnings].slice(0,200)};
}
