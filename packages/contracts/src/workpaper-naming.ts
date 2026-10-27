/** Display names are separate from the complete requirements retained on the entry. */
export function workpaperFilenameTitle(value:string):string {
  const input=value.replace(/\.docx$/i,'').replace(/批准[（(]备案[）)]/g,'批准或备案');
  let out='';
  for(let i=0;i<input.length;i++){
    if(!'（('.includes(input[i]!)){out+=input[i];continue;}
    const start=i;let depth=1;
    while(i+1<input.length&&depth){i++;if('（('.includes(input[i]!))depth++;else if('）)'.includes(input[i]!))depth--;}
    if(depth){out+=input.slice(start);break;}
    const note=input.slice(start+1,i),tail=input.slice(i+1);
    // A geographic/legal qualifier in a legal entity name is not an instruction.
    const legal=/^[\u4e00-\u9fffA-Za-z ·]{1,16}$/.test(note)&&/^(?:有限责任公司|有限公司|股份有限公司|集团)/.test(tail);
    if(legal)out+=input.slice(start,i+1);
    else if(/^(?:含|包括)/.test(note)&&!/[；;。]|如有|超过|低于|%|签字/.test(note))out+='及'+note.replace(/^(含|包括)/,'');
  }
  return out.replace(/、[、，]/g,'、').replace(/\s+/g,' ').replace(/^[、，\s]+|[、，\s]+$/g,'').trim()||value;
}
export function defaultWorkpaperIds(entries:{id:string;kind:string;sheet:string;code:string;title:string}[]):string[]{
  const sheets=new Set(entries.filter(e=>/^1\s*尽职调查文件\s*$/.test(e.sheet)).map(e=>e.sheet));
  return entries.filter(e=>e.kind==='file'&&(!sheets.size||sheets.has(e.sheet))).map(e=>e.id);
}
