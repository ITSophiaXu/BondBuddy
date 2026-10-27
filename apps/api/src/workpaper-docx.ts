import {ZipFile} from 'yazl';
import {WORKPAPER_DECISION_LABELS,type WorkpaperDecision,type WorkpaperEntry,type ProjectFileSource} from '@bondbuddy/contracts';
const xml=(s:string)=>s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
/** Deterministic editable statements; no model, original evidence or signed conclusion is fabricated. */
export async function workpaperDocx(title:string,paragraphs:string[]):Promise<Buffer>{
 const zip=new ZipFile(),chunks:Buffer[]=[];
 const result=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',c=>chunks.push(c));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);});
 const add=(name:string,text:string)=>zip.addBuffer(Buffer.from(text),name);
 add('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 add('_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 const p=(text:string,heading=false)=>'<w:p><w:pPr><w:spacing w:after="160" w:line="320" w:lineRule="auto"/>'+(heading?'<w:keepNext/><w:jc w:val="center"/>':'')+'</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="'+(heading?'32':'24')+'"/>'+(heading?'<w:b/>':'')+'</w:rPr><w:t xml:space="preserve">'+xml(text)+'</w:t></w:r></w:p>';
 add('word/document.xml','<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+p(title,true)+paragraphs.flatMap(s=>s.split('\n')).map(s=>p(s)).join('')+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>');
 zip.end();return result;
}
export function explanationParagraphs(entry:WorkpaperEntry,d:WorkpaperDecision,source:ProjectFileSource,confirmation:string){
 return ['底稿编号：'+entry.code,'对应文件：'+entry.title,'目录位置：'+(entry.folder||'根目录'),'判断类别：'+WORKPAPER_DECISION_LABELS[d.status],
 '本次处理：不生成该项底稿，保留本说明供归档及复核。','具体理由：'+d.reason,
 d.status==='not_applicable'?'适用性结论：根据下列募集说明书披露，本项业务不适用；该判断仍需人工专业复核。':'适用性结论：尚不能认定该业务不适用。当前资料或原始证据不足，本说明仅记录本次未生成的原因，不能替代核查证据或完成记录。',
 '采用来源：'+source.filename+' · V'+source.sequence+'；SHA-256：'+source.asset.pin.sha256,
 ...d.citations.map(c=>'募集书依据 ['+(c.location??c.span_id)+']：'+c.quote),
 ...(!d.citations.length?['募集书依据：未取得可准确引用的充分依据。']:[]),
 '待补材料：'+(d.missing_materials.join('；')||'请人工复核上述业务适用性及引用口径。'),
 '确认记录：用户已确认本批生成范围及不生成项。'+confirmation,
 '复核人：________    复核日期：________','本文件为 BondBuddy 生成的待复核说明，未执行现场核查、访谈、函证或签章。'];
}
