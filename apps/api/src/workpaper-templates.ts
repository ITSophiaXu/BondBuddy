import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import type {WorkpaperEntry} from '@bondbuddy/contracts';
const root=resolve(fileURLToPath(import.meta.url),'../../../../knowledge/workpaper-templates/2026-10-27');
type Template={id:string;code:string;title:string;family:string;filename:string;sha256:string;format:{roles:Record<string,{pPr:string;rPr:string}>;section:string}};
export function workpaperFamily(title:string){
  if(/不适用|暂无法形成/.test(title))return '不适用说明';
  if(/访谈/.test(title))return '访谈记录';
  if(/培训/.test(title))return '培训底稿';
  if(/诚信|失信|信用查询/.test(title))return '诚信查询记录';
  if(/发行人.*说明|公司.*说明|情况说明/.test(title))return '发行人说明';
  if(/基本情况.*核查记录|综合核查/.test(title))return '综合核查记录';
  return '专项核查文件';
}
export function selectWorkpaperTemplate(entry:Pick<WorkpaperEntry,'code'|'title'>,templates:Template[]){
  const family=workpaperFamily(entry.title),words=(s:string)=>new Set(s.replace(/发行人|公司|关于|核查|文件|说明|记录|情况/g,'').match(/[\u4e00-\u9fff]{2,}/g)?.flatMap(w=>Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)))??[]);
  const terms=words(entry.title);
  return templates.filter(t=>t.family===family).map(t=>{const common=[...words(t.title)].filter(w=>terms.has(w)).length;return {t,score:common+(common>0&&t.code===entry.code?100:0)};})
    .sort((a,b)=>b.score-a.score||a.t.id.localeCompare(b.t.id))[0]?.t;
}
export function loadWorkpaperTemplate(entry:Pick<WorkpaperEntry,'code'|'title'>){
  const templates=JSON.parse(readFileSync(resolve(root,'catalog.json'),'utf8')) as Template[];
  const match=selectWorkpaperTemplate(entry,templates);if(!match||!/^R\d{3}\.docx$/.test(match.filename))throw Error('WORKPAPER_TEMPLATE_MISSING');
  const bytes=readFileSync(resolve(root,match.filename));
  if(createHash('sha256').update(bytes).digest('hex')!==match.sha256)throw Error('WORKPAPER_TEMPLATE_CHANGED');
  return {...match,bytes};
}
