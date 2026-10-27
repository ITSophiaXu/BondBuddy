import {readBoundedOfficeParts} from './docx-inspector.js';
import type {loadWorkpaperTemplate} from './workpaper-templates.js';
import {ZipFile} from 'yazl';
import {WORKPAPER_DECISION_LABELS,type WorkpaperDecision,type WorkpaperEntry,type ProjectFileSource} from '@bondbuddy/contracts';
const xml=(s:string)=>s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
/** Deterministic editable statements; no model, original evidence or signed conclusion is fabricated. */
export async function workpaperDocx(title:string,paragraphs:string[],template?:ReturnType<typeof loadWorkpaperTemplate>):Promise<Buffer>{
 const zip=new ZipFile(),chunks:Buffer[]=[];
 const result=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',c=>chunks.push(c));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);});
 const add=(name:string,text:string)=>zip.addBuffer(Buffer.from(text),name);
 if(template){for(const [name,bytes] of readBoundedOfficeParts(template.bytes))if(name!=='word/document.xml')zip.addBuffer(bytes,name);}
 else{
 add('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 add('_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 }
 const p=(text:string,heading=false)=>{
   const role=template?.format.roles[heading?'title':'body'];
   if(role)return '<w:p>'+role.pPr+'<w:r>'+role.rPr+'<w:t xml:space="preserve">'+xml(text)+'</w:t></w:r></w:p>';
   return '<w:p><w:pPr><w:spacing w:after="160" w:line="320" w:lineRule="auto"/>'+(heading?'<w:keepNext/><w:jc w:val="center"/>':'')+'</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="'+(heading?'32':'24')+'"/>'+(heading?'<w:b/>':'')+'</w:rPr><w:t xml:space="preserve">'+xml(text)+'</w:t></w:r></w:p>';
 };
 add('word/document.xml','<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+p(title,true)+paragraphs.flatMap(s=>s.split('\n')).map(s=>p(s)).join('')+(template?template.format.section:'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>')+'</w:body></w:document>');
 zip.end();return result;
}
export function explanationParagraphs(entry:WorkpaperEntry,d:WorkpaperDecision,source:ProjectFileSource,confirmation:string){
 return [
 d.status==='not_applicable'?'本项业务不适用。'+d.reason:'本项暂无法形成文件。'+d.reason,
 ...(d.missing_materials.length?['尚需取得：'+d.missing_materials.map(s=>s.replace(/^请(?:提供|补充|取得)/,'').replace(/[。；;\s]+$/,'')).join('；')+'。']:[]),
 ...(d.status==='not_applicable'?[]:['现有资料不足以确认该事项不适用，亦不能替代相应原件或实际履职记录。'])];
}
