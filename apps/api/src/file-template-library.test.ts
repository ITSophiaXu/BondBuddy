import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ZipFile} from 'yazl';
import {workpaperDocx} from './workpaper-docx.js';
import {unpackTemplates,suggestTemplateMatches} from './file-template-library.js';
import {templateStructure,redactTemplateText} from './file-template-preview.js';
async function zip(files:Record<string,Buffer>,compress=true){const z=new ZipFile(),chunks:Buffer[]=[];const done=new Promise<Buffer>((resolve,reject)=>{z.outputStream.on('data',c=>chunks.push(c));z.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));z.outputStream.on('error',reject);});for(const [n,b] of Object.entries(files))z.addBuffer(b,n,{compress});z.end();return done;}

test('streamed template previews accept bounded Word XML above 8 MB and still remove historical values',async()=>{
 const bytes=await zip({'word/document.xml':Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+ ' '.repeat(9*1024*1024)+'Secret Enterprise</w:t></w:r></w:p><w:p><w:r><w:t>核查结论</w:t></w:r></w:p></w:body></w:document>')},false);
 const preview=templateStructure(bytes,'核查记录');assert.ok(!JSON.stringify(preview).includes('Secret'));assert.ok(JSON.stringify(preview).includes('核查结论'));assert.equal(unpackTemplates(bytes,'docx','large.docx').files.length,1);
});
test('template previews retain only complete generic labels, never values, companies or people',async()=>{
 const word=await workpaperDocx('张某与秘密企业有限公司',['姓名：张某','联系电话：13800001111','财务情况','未知别名：秘密','核查结论']);const p=templateStructure(word,'核查记录');
 assert.ok(!JSON.stringify(p).includes('秘密'));assert.ok(!JSON.stringify(p).includes('张某'));assert.ok(!JSON.stringify(p).includes('13800001111'));assert.ok(JSON.stringify(p).includes('财务情况'));assert.equal(redactTemplateText('公司名称：未枚举企业'),'公司名称：【本项信息】');
});
test('same-path Word/PDF is one template; equal bytes in distinct roles remain separate records',async()=>{
 const word=await workpaperDocx('核查记录',['日期']);const bytes=await zip({'1 核查记录.docx':word,'1 核查记录.pdf':Buffer.from('%PDF'),'2 发行人说明.docx':word,'3 原件.pdf':Buffer.from('%PDF'),'nested.zip':Buffer.from('zip')});
 const r=unpackTemplates(bytes,'zip','package.zip');assert.equal(r.files.length,2);assert.equal(r.warnings.length,3);
 assert.throws(()=>unpackTemplates(Buffer.from('not a zip'),'zip','bad.zip'));
});
test('same code remains a suggestion and multiple roles are never silently selected',()=>{
 const entry={id:'a',code:'1',title:'核查记录',kind:'file' as const,path:'a.docx',row:1,sheet:'目录',folder:'',instructions:''},record={set_id:'set',record_id:'one',sha256:'a'.repeat(64),code:'1',name:'核查记录',role:'核查记录',document_type:'workpaper' as const};
 const set={set_id:'set',name:'模板',version:'1',origin:'private' as const,records:[record],warnings:[]};assert.equal(suggestTemplateMatches([entry],set)[0].status,'suggested');
 assert.equal(suggestTemplateMatches([entry],{...set,records:[record,{...record,record_id:'two'}]})[0].status,'multiple');assert.equal(suggestTemplateMatches([{...entry,code:'2'}],set)[0].status,'missing');
});
test('renumbered catalogues match by subject without exposing private names, while role conflicts stay explicit',()=>{
 const entry={id:'a',code:'9',title:'主要客户、供应商稳定性核查记录',kind:'file' as const,path:'a.docx',row:1,sheet:'目录',folder:'',instructions:''};
 const record={set_id:'set',record_id:'one',sha256:'a'.repeat(64),code:'1',name:'核查记录',role:'核查记录',document_type:'workpaper' as const};
 const set={set_id:'set',name:'模板',version:'1',origin:'private' as const,records:[record,{...record,record_id:'two',role:'发行人说明'}],warnings:[]};
 const result=suggestTemplateMatches([entry],set,new Map([['one','主要客户、供应商稳定性核查记录.docx'],['two','主要客户、供应商稳定性说明.docx']]));
 assert.equal(result[0].status,'suggested');assert.equal(result[0].candidates[0].record_id,'one');assert.ok(!JSON.stringify(result).includes('.docx'));
});
