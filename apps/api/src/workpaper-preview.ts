import {SaxesParser} from 'saxes';
import {readBoundedOfficeParts} from './docx-inspector.js';
/** Text only; never inject uploaded OOXML or HTML into the browser. */
export function workpaperPreview(bytes:Buffer):string {
  const parts=readBoundedOfficeParts(bytes),chunks:string[]=[];
  for(const name of ['word/document.xml','word/footnotes.xml','word/endnotes.xml']){
    const raw=parts.get(name);if(!raw)continue;
    if(/<!DOCTYPE|<!ENTITY/i.test(raw.toString('utf8')))throw Error('WORKPAPER_PREVIEW_INVALID');
    const parser=new SaxesParser({xmlns:true});let text=false,deleted=0;
    parser.on('opentag',tag=>{if(tag.local==='del')deleted++;if(tag.local==='t')text=true;});
    parser.on('text',value=>{if(text&&!deleted)chunks.push(value);});
    parser.on('closetag',tag=>{if(tag.local==='t')text=false;if(tag.local==='del')deleted--;if(!deleted){if(tag.local==='p'||tag.local==='tr')chunks.push('\n');if(tag.local==='tc')chunks.push('\t');}});
    parser.write(raw.toString('utf8')).close();
  }
  const value=chunks.join('');if(value.length>4000000)throw Error('WORKPAPER_PREVIEW_TOO_LARGE');return value;
}
