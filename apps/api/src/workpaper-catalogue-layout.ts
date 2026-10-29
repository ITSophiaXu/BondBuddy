import type {WorkpaperColumnMapping} from '@bondbuddy/contracts';
export type CatalogueSheet={name:string;rows:{row:number;cells:string[]}[];merges?:{column:number;start:number;end:number}[]};
export const header=(s='')=>s.replace(/[\s：:（）()]/g,'').toLowerCase();
export const aliases={
  title:['底稿名称','文件名称','材料名称','资料名称','目录名称','底稿内容','文件名','名称','项目','资料清单','核查事项','核查内容','尽调事项','工作底稿','文件标题','title','filename','document','item'],
  code:['底稿编号','文件编号','索引号','索引编号','编号','序号','索引','code','no.','no','index'],
  folder:['目录路径','文件夹','所属目录','目录层级','分类','路径','一级目录','二级目录','三级目录','folder','category'],
  instructions:['编制要求','底稿要求','内容要求','核查要求','资料要求','说明','备注','要求','requirements','notes'],
  kind:['类型','条目类型','文件类型','type'],
} as const;
export const isHeader=(value:string)=>Object.values(aliases).some(names=>(names as readonly string[]).includes(header(value)));
const codePattern=String.raw`(?:\d{1,3}(?:[-.．、]\d{1,3})*|[A-Za-z]{1,5}[-.]?\d{1,3}(?:[-.．]\d{1,3})*|[（(][一二三四五六七八九十百\d]+[）)]|[一二三四五六七八九十百]+[、.]?)`;
const codeRegex=new RegExp('^'+codePattern+'$');
export const numberedCode=(value='')=>codeRegex.test(value.trim());
const combinedRegex=new RegExp('^('+codePattern+')(?:[\\s、:：]+|[.．](?=[^\\d]))(.+)$');
const bracketedRegex=/^([（(][一二三四五六七八九十百\d]+[）)])\s*(.+)$/;
export function splitCode(value:string){const m=value.trim().match(combinedRegex)??value.trim().match(bracketedRegex);return m?{code:m[1]!,title:m[2]!.trim()}:undefined;}
const textTitle=(value='')=>!!value.trim()&&!numberedCode(value)&&!/^[-+\d\s,.%％]+$/.test(value)&&!isHeader(value);
export function columnLabel(index:number){let n=index+1,s='';while(n){s=String.fromCharCode(65+(n-1)%26)+s;n=Math.floor((n-1)/26);}return s;}

/** Infer structure from source values; low-confidence guesses are only proposals for review. */
export function detectCatalogueLayout(sheets:CatalogueSheet[]){
  const mapping:WorkpaperColumnMapping[]=[],warnings:string[]=[];let needs_review=false;
  for(const sheet of sheets){
    const rows=sheet.rows.filter(r=>r.cells.some(c=>c?.trim()));if(!rows.length)continue;
    const last=rows.at(-1)!.row;
    const heads=rows.filter(r=>r.cells.some(c=>(aliases.title as readonly string[]).includes(header(c))));
    if(heads.length){
      // Repeated page headers are skipped later. A changed layout starts a new block.
      let previous='';
      for(const head of heads){
        const cols=(names:readonly string[])=>head.cells.flatMap((c,i)=>names.includes(header(c))?[i]:[]);
        const title=cols(aliases.title),code=cols(aliases.code),kind=cols(aliases.kind),folders=cols(aliases.folder),instructions=cols(aliases.instructions);
        const signature=JSON.stringify([title,code,kind,folders,instructions]);if(signature===previous)continue;
        if(previous)mapping.at(-1)!.last_row=head.row-1;previous=signature;
        if(title.length>1||code.length>1||kind.length>1)needs_review=true;
        mapping.push({sheet:sheet.name,first_row:head.row+1,last_row:Math.max(head.row+1,last),title_column:title[0]!,
          ...(code.length?{code_column:code[0]}:{}),...(kind.length?{kind_column:kind[0]}:{}),folder_columns:folders.slice(0,12),instruction_columns:instructions.slice(0,12),split_code:!code.length});
      }
      continue;
    }
    const width=Math.max(...rows.map(r=>r.cells.length));
    const candidates:{title:number;code?:number;split:boolean;count:number;first:number}[]=[];
    const evidence=Array.from({length:width},(_,col)=>({
      codes:rows.filter(r=>numberedCode(r.cells[col])).map(r=>r.row),
      titles:new Set(rows.filter(r=>textTitle(r.cells[col])).map(r=>r.row)),
      combined:rows.filter(r=>!!splitCode(r.cells[col]??'')).map(r=>r.row),
    }));
    for(let t=0;t<width;t++){
      const {combined,titles}=evidence[t]!;
      if(combined.length>=2)candidates.push({title:t,split:true,count:combined.length,first:combined[0]!});
      if(titles.size<2)continue;
      for(let c=0;c<width;c++)if(c!==t&&evidence[c]!.codes.length>=2){
        const matches=evidence[c]!.codes.filter(row=>titles.has(row));
        if(matches.length>=2)candidates.push({title:t,code:c,split:false,count:matches.length,first:matches[0]!});
      }
    }
    candidates.sort((a,b)=>b.count-a.count||a.title-b.title||(a.code??-1)-(b.code??-1));
    const best=candidates[0];
    if(best){
      if(candidates[1]?.count===best.count)needs_review=true;
      mapping.push({sheet:sheet.name,first_row:best.first,last_row:last,title_column:best.title,...(best.code===undefined?{}:{code_column:best.code}),split_code:best.split,folder_columns:[],instruction_columns:[]});
      warnings.push(`工作表“${sheet.name}”未设置表头，已根据单元格内容推测编号和名称，请核对。`);
    }else{
      // A plain text list may be a directory or explanatory prose. Never auto-import it.
      const columns=Array.from({length:width},(_,i)=>({i,count:rows.filter(r=>textTitle(r.cells[i])).length})).sort((a,b)=>b.count-a.count);
      if(columns[0]?.count&&rows.length>=2)mapping.push({sheet:sheet.name,first_row:rows[0]!.row,last_row:last,title_column:columns[0].i,split_code:false,folder_columns:[],instruction_columns:[]});
      warnings.push(`工作表“${sheet.name}”的目录结构需要确认；请选择文件名称所在列和条目行范围。`);needs_review=true;
    }
  }
  return {mapping,warnings,needs_review};
}
