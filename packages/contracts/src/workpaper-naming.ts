/** Display names are separate from the complete requirements retained on the entry. */
export function workpaperFilenameTitle(value:string):string {
  const input=value.replace(/\.docx$/i,'').replace(/批准[（(]备案[）)]/g,'批准或备案');
  let out='';
  for(let i=0;i<input.length;i++){
    if('）)'.includes(input[i]!))continue;
    if(!'（('.includes(input[i]!)){out+=input[i];continue;}
    const start=i;let depth=1;
    while(i+1<input.length&&depth){i++;if('（('.includes(input[i]!))depth++;else if('）)'.includes(input[i]!))depth--;}
    // An unfinished annotation must not leak the remaining instructions into a filename.
    if(depth)break;
    const note=input.slice(start+1,i),tail=input.slice(i+1);
    // A geographic/legal qualifier in a legal entity name is not an instruction.
    const legal=/^[\u4e00-\u9fffA-Za-z ·]{1,16}$/.test(note)&&/^(?:有限责任公司|有限公司|股份有限公司|公司|集团|合伙企业|\s*(?:Ltd\b|Limited\b|Inc\b|LLC\b))/i.test(tail);
    if(legal)out+=input.slice(start,i+1);
  }
  return out.replace(/、[、，]/g,'、').replace(/\s+/g,' ').replace(/^[、，\s]+|[、，\s]+$/g,'').trim()||'底稿';
}

/** Windows' ZIP folder rejects a UTF-8 member path at 260 bytes, even when the
 * decoded name is shorter. Leave room for the category, folders and extension. */
export const WORKPAPER_ZIP_PATH_BYTES=240;
const filenameBytes=180,folderBytes=40;
const encoder=new TextEncoder();
const byteLength=(value:string)=>encoder.encode(value).length;
function prefixBytes(value:string,limit:number):string {
  let out='',size=0;
  for(const character of value){const bytes=byteLength(character);if(size+bytes>limit)break;out+=character;size+=bytes;}
  return out;
}
function bounded(value:string,limit:number):string {
  return byteLength(value)<=limit?value:prefixBytes(value,Math.max(0,limit-3)).replace(/[. ，、；;\s]+$/u,'')+'…';
}
/** File-system safety is separate from removing catalogue annotations. */
export function workpaperPathPart(value:string):string {
  const clean=value.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/g,'').trim();
  return !clean||/^\.+$/.test(clean)?'未命名':/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(clean)?'_'+clean:clean;
}
export function workpaperFolderPath(value:string):string {
  const parts=value.split(/[\\/]+/).filter(Boolean).map(part=>workpaperPathPart(workpaperFilenameTitle(part)));
  return bounded(parts.join('/'),folderBytes).replace(/\/$/,'');
}
type NamingEntry={code?:string;title?:string;path?:string;folder?:string};
type NameOptions={explanation?:boolean;suffix?:string};
/** Recompute from the retained original title, never from a legacy name which
 * may already have flattened a parenthesized instruction into ordinary text. */
export function workpaperDownloadFilename(entry:NamingEntry,options:NameOptions={}):string {
  const legacy=entry.path?.split('/').at(-1)?.replace(/\.docx$/i,'')??'底稿';
  const code=workpaperPathPart(entry.code??'');
  const prefix=entry.code?.trim()?code+' ':'';
  let title=workpaperPathPart(workpaperFilenameTitle(entry.title??legacy));
  const duplicate=entry.path?.match(/ (\(\d+\))\.docx$/i)?.[1];
  const suffix=(options.explanation?'-不适用说明':'')+(options.suffix??(duplicate?' '+duplicate:''))+'.docx';
  const budget=filenameBytes-byteLength(prefix+suffix);
  // Catalogue codes are normally short indices. Refuse an impossible name
  // instead of silently changing an original index.
  if(budget<12)throw new Error('底稿编号过长，无法保留编号并生成兼容的文件名。');
  if(byteLength(title)>budget){
    const first=title.split(/[。；;\n]/u)[0]!.trim();
    if(first)title=first;
    if(byteLength(title)>budget){
      const role=title.match(/(?:专项核查文件|核查记录|分析文件|说明文件|承诺文件|证明文件|情况说明|明细表|调查文件|访谈记录|查询文件|报告|说明)$/u)?.[0]??'';
      title=bounded(role?title.slice(0,-role.length):title,budget-byteLength(role))+role;
    }
  }
  return prefix+title+suffix;
}
export function workpaperRelativePath(entry:NamingEntry,options:NameOptions={}):string {
  const folder=workpaperFolderPath(entry.folder??entry.path?.split('/').slice(0,-1).join('/')??'');
  return [folder,workpaperDownloadFilename(entry,options)].filter(Boolean).join('/');
}
/** One allocator per archive also handles names that become equal after notes
 * are removed. No document can overwrite another or create duplicate members. */
export function workpaperZipPath(entry:NamingEntry,explanation:boolean,used:Set<string>):string {
  const root=explanation?'不适用说明/':'可生成文件/';
  let path=root+workpaperRelativePath(entry,{explanation}),ordinal=1;
  while(used.has(path.toLocaleLowerCase('en-US')))path=root+workpaperRelativePath(entry,{explanation,suffix:` (${++ordinal})`});
  if(byteLength(path)>WORKPAPER_ZIP_PATH_BYTES)throw new Error('底稿压缩包路径过长。');
  used.add(path.toLocaleLowerCase('en-US'));return path;
}
export function defaultWorkpaperIds(entries:{id:string;kind:string;sheet:string;code:string;title:string}[]):string[]{
  const sheets=new Set(entries.filter(e=>/^1\s*尽职调查文件\s*$/.test(e.sheet)).map(e=>e.sheet));
  return entries.filter(e=>e.kind==='file'&&(!sheets.size||sheets.has(e.sheet))).map(e=>e.id);
}
