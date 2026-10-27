import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {posix} from 'node:path';
import {WORKPAPER_LIMITS,workpaperPathPart,workpaperFilenameTitle,type WorkpaperEntry} from '@bondbuddy/contracts';
import {readBoundedOfficeParts} from './docx-inspector.js';
import {Problem} from './data.js';
const invalid=(message:string):never=>{throw new Problem(422,'VALIDATION_FAILED',message);};
const array=(v:any):any[]=>v===undefined?[]:Array.isArray(v)?v:[v];
// Excel writers may encode Chinese text as decimal or hexadecimal XML references.
const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:false,processEntities:true,htmlEntities:true});
const plain=(v:any):string=>v==null?'':typeof v==='object'?(v['#text']??(v.t!==undefined?plain(v.t):array(v.r).map(r=>plain(r.t)).join(''))):String(v);
const header=(s='')=>s.replace(/[\s：:（）()]/g,'').toLowerCase();
const aliases={title:['底稿名称','文件名称','材料名称','资料名称','目录名称','底稿内容','文件名','名称','项目'],code:['底稿编号','文件编号','索引号','索引编号','编号','序号'],folder:['目录路径','文件夹','所属目录','目录层级','分类','路径'],instructions:['编制要求','底稿要求','内容要求','说明','备注'],kind:['类型','条目类型','文件类型']} as const;
export type CatalogueSheet={name:string;rows:{row:number;cells:string[]}[]};

export function parseCatalogueRows(sheets:CatalogueSheet[]):{entries:WorkpaperEntry[];warnings:string[]}{
  const entries:WorkpaperEntry[]=[],warnings:string[]=[];let totalRows=0;
  for(const sheet of sheets){
    if((totalRows+=sheet.rows.length)>WORKPAPER_LIMITS.rows)invalid('目录最多支持 10,000 行，请拆分后上传。');
    const head=sheet.rows.findIndex(r=>r.cells.some(c=>aliases.title.includes(header(c) as any)));
    if(head<0){warnings.push(`工作表“${sheet.name}”没有识别到文件名称列，已跳过。`);continue;}
    const cols=Object.fromEntries(Object.entries(aliases).map(([key,names])=>[key,sheet.rows[head]!.cells.findIndex(c=>(names as readonly string[]).includes(header(c)))]));
    const local:WorkpaperEntry[]=[];
    for(const row of sheet.rows.slice(head+1)){
      const get=(key:string)=>row.cells[cols[key]!]??'';
      const title=get('title').trim(),code=get('code').trim();
      if(!title||aliases.title.includes(header(title) as any)||/^(注|备注|填表说明)[：:]?$/.test(code))continue;
      if(title.length>300||code.length>100||get('instructions').length>2000||get('folder').length>600)invalid(`“${sheet.name}”第 ${row.row} 行文字过长，请缩短后上传。`);
      const kind=/^(目录|文件夹|章节|分类|folder)$/i.test(get('kind').trim())?'folder':'file';
      local.push({id:`s${sheets.indexOf(sheet)+1}-r${row.row}`,code,title,folder:get('folder').trim(),instructions:get('instructions').trim(),sheet:sheet.name,row:row.row,kind,path:''});
    }
    // Numbered summary rows are deliverables too. Only an explicit 类型=目录
    // marks a folder; hierarchy alone must never silently discard a workpaper.
    const stack:WorkpaperEntry[]=[];
    for(const item of local){
      if(!item.code&&item.kind==='folder')stack.length=0;
      while(stack.length&&stack.at(-1)!.code&&!(item.code&&item.code.startsWith(stack.at(-1)!.code)&&/^[.．\-、]/.test(item.code.slice(stack.at(-1)!.code.length))))stack.pop();
      const folder=item.folder?item.folder.split(/[\\/]+/).filter(Boolean).map(workpaperPathPart):stack.map(p=>workpaperPathPart([p.code,workpaperFilenameTitle(p.title)].filter(Boolean).join(' ')));
      if(sheets.length>1)folder.unshift(workpaperPathPart(sheet.name));
      item.folder=folder.join('/');
      if(item.folder.length>600)invalid(`“${sheet.name}”第 ${item.row} 行保存目录过长，请缩短目录名称。`);
      item.path=[...folder,workpaperPathPart([item.code,workpaperFilenameTitle(item.title)].filter(Boolean).join(' '))+(item.kind==='file'?'.docx':'')].join('/');
      if(item.path.length>950)invalid(`“${sheet.name}”第 ${item.row} 行目录层级过长。`);
      entries.push(item);if(item.kind==='folder')stack.push(item);
    }
  }
  const files=entries.filter(e=>e.kind==='file');
  if(!files.length)invalid('未识别到可生成文件。请设置“底稿名称”或“文件名称”列，并在“类型”列用“目录”标明文件夹。');
  if(files.length>WORKPAPER_LIMITS.items)invalid('每批最多支持 1,000 份文件，请拆分目录。');
  const used=new Set<string>();
  for(const e of files){let path=e.path;let suffix=1;while(used.has(path.toLowerCase()))path=e.path.replace(/\.docx$/i,` (${++suffix}).docx`);
    if(path!==e.path)warnings.push(`“${e.sheet}”第 ${e.row} 行与其他文件重名，下载时使用“${path}”。`);e.path=path;used.add(path.toLowerCase());}
  return {entries,warnings};
}

/** Read cells only: never evaluate formulas, hyperlinks, macros or external relationships. */
export function parseWorkpaperXlsx(bytes:Buffer,scope:'due_diligence'|'all'='due_diligence'){
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
        const index=[...letters!].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;if(index>99)continue;
        if(cell.f!==undefined){warnings.push(`“${name}”${address} 为公式，未作为底稿目录内容读取，请转为值后上传。`);continue;}
        cells[index]=cell['@_t']==='s'?shared[Number(cell.v)]??'':cell['@_t']==='inlineStr'?plain(cell.is):plain(cell.v);
      }
      rows.push({row:number,cells});
    }
    // Only merged classification cells are inherited; merged titles remain single directory rows.
    const first=rows.find(r=>r.cells.some(c=>c&&aliases.title.includes(header(c) as any)));
    const folderCol=first?.cells.findIndex(c=>c&&(aliases.folder as readonly string[]).includes(header(c)));
    if(folderCol!==undefined&&folderCol>=0)for(const merged of array(data.worksheet?.mergeCells?.mergeCell)){
      const match=String(merged['@_ref']).match(/^([A-Z]+)(\d+):\1(\d+)$/);if(!match)continue;
      const col=[...match[1]!].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;if(col!==folderCol)continue;
      const start=Number(match[2]),end=Number(match[3]),value=rows.find(r=>r.row===start)?.cells[col];
      if(value)for(const row of rows)if(row.row>start&&row.row<=end&&!row.cells[col])row.cells[col]=value;
    }
    result.push({name,rows});
  }
  const parsed=parseCatalogueRows(result);return {entries:parsed.entries,warnings:[...warnings,...parsed.warnings].slice(0,200)};
}
