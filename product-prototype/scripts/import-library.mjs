// Operator ingestion, intentionally separate from customer project uploads.
// No network fetch: obtain official files first and record their exact source URLs.
import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { ProspectusLibrary } from '../lib/prospectus-library.mjs';
import { ROOT } from '../lib/platform.mjs';

const [manifestPath,...flags]=process.argv.slice(2);
if(!manifestPath||flags.some(f=>f!=='--publish')){
  console.error('用法：node scripts/import-library.mjs <JSON/JSONL清单> --publish\n公共发布须逐项标注 reviewed: true；允许仅索引，不会自动抓取链接。');process.exitCode=1;
}else{
  const path=resolve(manifestPath),content=(await readFile(path,'utf8')).replace(/^\uFEFF/,'');
  const rows=path.toLowerCase().endsWith('.jsonl')?content.split(/\r?\n/).filter(l=>l.trim()).map(l=>JSON.parse(l)):JSON.parse(content);
  if(!Array.isArray(rows)||!rows.length||rows.length>500)throw new Error('清单须为1—500条记录的数组，或每行一条JSON记录。');
  if(!flags.includes('--publish'))throw new Error('请明确指定 --publish，确认将清单发布到公共资料库。个人索引请使用页面入口。');
  const library=new ProspectusLibrary(join(resolve(process.env.BOND_BUDDY_RUNTIME||join(ROOT,'runtime')),'library'));
  const results=[];
  for(const [i,row] of rows.entries()){
    try{
      if(row.reviewed!==true)throw new Error('维护人员尚未核对该条目，未发布。');
      const file=row.filePath?{filename:basename(row.filePath),content:await readFile(resolve(dirname(path),row.filePath))}:undefined;
      const item=await library.add(row,{owner:'library-operator',visibility:'public',operator:true,confirmed:true,file});
      results.push({row:i+1,id:item.id,title:item.title,status:item.duplicate?'已存在':item.textReady?'已收录正文':'已收录索引',parseStatus:item.parseStatus});
    }catch(e){process.exitCode=1;results.push({row:i+1,error:e.message});}
  }
  console.log(JSON.stringify(results,null,2));
}
