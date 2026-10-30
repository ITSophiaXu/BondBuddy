import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {PROJECT_DOCUMENT_CATALOG,type FileTemplateSet,type FileTemplateRecord,type FileTemplatePin,type FileTemplateChoice,type FileTemplatePreview,type M4DocumentType,type M4MaterialPin,type M4TemplateRef,type WorkpaperEntry,type FileTemplateMatch} from '@bondbuddy/contracts';
import {project,uid,digest,missing,conflict,Problem,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {readM4MaterialPin} from './m4-workspace.js';
import {readBoundedZipParts} from './docx-inspector.js';
import {templateStructure} from './file-template-preview.js';
type Db=Pool|PoolClient;
export const TEMPLATE_MAX_BYTES=64*1024*1024;
export const WORD_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type StoredRecord=Omit<FileTemplateRecord,'set_id'> & {object_key:string;preview:FileTemplatePreview;match_title:string;byte_size:number};
export type TemplateBundle={version:string;name:string;catalogue:{path:string;sha256:string};records:{id:string;path:string;sha256:string;name:string;code:string;role:string;document_type:M4DocumentType;match_title?:string}[]};
const invalid=(message:string):never=>{throw new Problem(422,'VALIDATION_FAILED',message);};
export async function builtinBundle():Promise<TemplateBundle|null>{
 const root=process.env.BB_FILE_TEMPLATE_BUNDLE;if(!root)return null;
 const b=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8')) as TemplateBundle;
 if(!/^[a-zA-Z0-9._-]{1,100}$/.test(b.version)||!b.records?.length||b.records.length>500||new Set(b.records.map(r=>r.id)).size!==b.records.length)throw Error('TEMPLATE_BUNDLE_INVALID');
 return b;
}
export async function bundleBytes(path:string,hash:string){
 const root=await realpath(process.env.BB_FILE_TEMPLATE_BUNDLE!),file=await realpath(resolve(root,path)),rel=relative(root,file);
 if(isAbsolute(rel)||rel.startsWith('..'))throw Error('TEMPLATE_BUNDLE_PATH');
 const bytes=await readFile(file);if(bytes.length>TEMPLATE_MAX_BYTES||digest(bytes)!==hash)throw Error('TEMPLATE_BUNDLE_HASH');return bytes;
}
export function templateSetDto(r:any):FileTemplateSet{return {set_id:r.id,name:r.name,version:r.version,origin:r.origin,warnings:r.warnings,records:(r.records as StoredRecord[]).map(({object_key:_key,preview:_preview,match_title:_title,...s})=>({...s,set_id:r.id}))};}
export async function readTemplateSets(db:Db,owner:string,id:string){await project(db,owner,id);return (await db.query('SELECT * FROM bb_file_template_sets WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC',[owner,id])).rows.map(templateSetDto);}
export async function templateMatches(db:Db,owner:string,id:string,entries:WorkpaperEntry[],setId:string){
 await project(db,owner,id);const row=(await db.query('SELECT * FROM bb_file_template_sets WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[owner,id,setId])).rows[0];if(!row)throw missing();
 // Original filenames are useful for matching but never leave the service.
 return suggestTemplateMatches(entries,templateSetDto(row),new Map((row.records as StoredRecord[]).map(r=>[r.record_id,r.match_title])));
}
export async function templateRecord(db:Db,owner:string,id:string,pin:FileTemplatePin){
 await project(db,owner,id);const s=(await db.query('SELECT * FROM bb_file_template_sets WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[owner,id,pin.set_id])).rows[0];
 const r=(s?.records as StoredRecord[]|undefined)?.find(r=>r.record_id===pin.record_id&&r.sha256===pin.sha256);if(!r)throw missing();return {set:s,record:r};
}
function safeRole(name:string){return /不适用/.test(name)?'不适用说明':/访谈/.test(name)?'访谈记录':/培训/.test(name)?'培训底稿':/说明/.test(name)?'发行人说明':/记录/.test(name)?'核查记录':'核查文件';}
export function unpackTemplates(bytes:Buffer,format:'zip'|'docx',filename:string){
 let parts:Map<string,Buffer>;
 try{parts=format==='zip'?readBoundedZipParts(bytes):new Map([[filename,bytes]]);}catch{invalid('模板包损坏或超过安全读取限制，请拆分后重试。');}
 if(parts!.size>500)invalid('一次最多导入 500 个文件，请拆分模板包。');
 const files:{name:string;bytes:Buffer}[]=[],warnings:string[]=[];
 const docxStems=new Set([...parts!.keys()].filter(n=>/\.docx$/i.test(n)).map(n=>n.slice(0,-5).normalize('NFC')));
 for(const [name,raw] of parts!){
  if(name.split('/').some(n=>n.startsWith('.')||n.startsWith('~$'))){warnings.push('已忽略临时或隐藏文件。');continue;}
  if(/\.pdf$/i.test(name)&&docxStems.has(name.slice(0,-4).normalize('NFC'))){warnings.push('同路径同名 PDF 已忽略，采用对应 Word。');continue;}
  if(!/\.docx$/i.test(name)){warnings.push(/\.pdf$/i.test(name)?'仅有 PDF 的文件未导入，请补充 Word 或选择其他模板。':/\.doc$/i.test(name)?'旧版 DOC 请另存为 DOCX 后上传。':'已跳过非 DOCX 文件或内嵌压缩包。');continue;}
  // Validate ALL entries, not only main XML; no path traversal, symlinks or bombs.
  try{const xml=readBoundedZipParts(raw,()=>true,true);if(!xml.has('word/document.xml')||[...xml.keys()].some(n=>/vbaProject|activeX|embeddings/i.test(n)))throw Error('unsupported');templateStructure(raw,'模板');}
  catch{warnings.push(`第 ${files.length+warnings.length+1} 个文件无法作为安全的 Word 模板读取，未导入。`);continue;}
  files.push({name,bytes:raw});
 }
 if(!files.length)invalid('没有可使用的 DOCX 模板。请检查文件格式；PDF、DOC 和内嵌压缩包需先转换或解压。');
 return {files,warnings};
}
export async function storeTemplateSet(c:PoolClient,blobs:PrivateBlobs,owner:string,id:string,request:string,hash:string,files:{name:string;bytes:Buffer;meta?:TemplateBundle['records'][number]}[],type:M4DocumentType,origin:'builtin'|'private',version:string,warnings:string[]=[]){
 await project(c,owner,id,true);
 const old=(await c.query('SELECT * FROM bb_file_template_sets WHERE owner_user_id=$1 AND request_id=$2',[owner,request])).rows[0];
 if(old){if(old.request_hash.trim()!==hash||old.project_id!==id)throw conflict('IDEMPOTENCY_CONFLICT','此导入请求已用于其他模板包。');return templateSetDto(old);}
 const existing=(await c.query('SELECT records FROM bb_file_template_sets WHERE owner_user_id=$1 AND project_id=$2',[owner,id])).rows;
 const assets=new Map<string,number>();for(const set of existing)for(const r of set.records)assets.set(r.sha256,r.byte_size??0);for(const file of files)assets.set(digest(file.bytes),file.bytes.length);
 if(existing.length>=500||assets.size>1000||[...assets.values()].reduce((a,b)=>a+b,0)>500*1024*1024)invalid('本项目模板库已达到容量上限（1,000 份不同 Word / 500 MB），请拆分到其他项目。');
 const setId=uid(),records:StoredRecord[]=new Array(files.length),savedAssets=new Map<string,Promise<void>>();
 let next=0,failure:unknown;
 // Bound storage concurrency and preserve the original record order. Wait for
 // every in-flight readback before allowing the surrounding transaction to end.
 await Promise.all(Array.from({length:Math.min(4,files.length)},async()=>{while(!failure){
  const index=next++;if(index>=files.length)return;const f=files[index];
  try{
  const sha256=digest(f.bytes),code=f.meta?.code??f.name.split('/').at(-1)!.match(/^\d+(?:[-.－]\d+)*/)?.[0]??'',role=f.meta?.role??safeRole(f.name),document_type=f.meta?.document_type??type;
  const name=f.meta?.name??(document_type==='workpaper'?`${code?code+' · ':''}${role} · ${index+1}`:PROJECT_DOCUMENT_CATALOG.find(d=>d.id===document_type)?.name??'文件模板');
  const preview=templateStructure(f.bytes,name),key=`users/${owner}/projects/${id}/file-templates/assets/${sha256}.docx`;
  let saved=savedAssets.get(sha256);
  if(!saved){saved=(async()=>{await blobs.put(key,f.bytes,WORD_MIME);const readback=await blobs.getIfExistsBounded(key,TEMPLATE_MAX_BYTES);if(!readback||digest(readback)!==sha256)throw Error('TEMPLATE_STORE_FAILED');})();savedAssets.set(sha256,saved);}
  await saved;
  records[index]={record_id:f.meta?.id??uid(),sha256,code,role,document_type,name,object_key:key,preview,match_title:f.meta?.match_title??f.name,byte_size:f.bytes.length};
  }catch(error){failure=error;}
 }}));
 if(failure)throw failure;
 const row=(await c.query('INSERT INTO bb_file_template_sets(id,owner_user_id,project_id,request_id,request_hash,name,version,origin,records,warnings) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[setId,owner,id,request,hash,origin==='builtin'?'光大证券模板':'我的模板包',version,origin,JSON.stringify(records),JSON.stringify(warnings)])).rows[0];return templateSetDto(row);
}
export async function storeTemplateMaterial(c:PoolClient,blobs:PrivateBlobs,owner:string,id:string,bytes:Buffer,filename:string,media=WORD_MIME,internal=false):Promise<M4MaterialPin>{
 const sha256=digest(bytes),upload=uid(),material=uid(),key=`users/${owner}/projects/${id}/uploads/${upload}`;
 await blobs.put(key,bytes,media);const saved=await blobs.getIfExistsBounded(key,TEMPLATE_MAX_BYTES);if(!saved||digest(saved)!==sha256)throw Error('TEMPLATE_STORE_FAILED');
 await c.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_bytes,received_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,'other',$8,now()+interval '1 hour','completed',$6,$7)`,[upload,owner,id,filename,media,bytes.length,sha256,key]);
 await c.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'other',$5,$6,$7,$8,$9,'persisted')`,[material,owner,id,upload,filename,media,bytes.length,sha256,key]);
 if(internal)await c.query('UPDATE bb_material_versions SET internal_template=true WHERE owner_user_id=$1 AND id=$2',[owner,material]);
 return {source_project_id:id,material_id:material,material_version:1,sha256};
}
export async function resolveTemplate(c:PoolClient,blobs:PrivateBlobs,owner:string,id:string,choice:FileTemplateChoice,type:M4DocumentType):Promise<{template:M4TemplateRef;material:M4MaterialPin}>{
 const p=await project(c,owner,id,true);
 if('private_template' in choice){const t=(await c.query('SELECT * FROM bb_m4_templates WHERE owner_user_id=$1 AND id=$2 AND version=$3 AND retired_at IS NULL',[owner,choice.private_template.template_id,choice.private_template.template_version])).rows[0];
  if(!t||t.sha256.trim()!==choice.private_template.sha256||t.document_type!==type||t.market!==p.market||t.offering!==p.offering)throw missing();await readM4MaterialPin(c,owner,t.material,true);return {template:choice.private_template,material:t.material};}
 const {set,record:r}=await templateRecord(c,owner,id,choice);if(r.document_type!==type)invalid('模板文种与本次文件不一致。');
 const adopted=(await c.query('SELECT * FROM bb_file_template_adoptions WHERE owner_user_id=$1 AND project_id=$2 AND set_id=$3 AND record_id=$4',[owner,id,choice.set_id,choice.record_id])).rows[0];
 if(adopted){await readM4MaterialPin(c,owner,adopted.material,true);return {template:adopted.template_ref,material:adopted.material};}
 const bytes=await blobs.getIfExistsBounded(r.object_key,TEMPLATE_MAX_BYTES);if(!bytes||digest(bytes)!==r.sha256)throw new Problem(503,'DATA_UNAVAILABLE','模板原件暂不可用。');
 const material=await storeTemplateMaterial(c,blobs,owner,id,bytes,r.name+'.docx',WORD_MIME,true),template={template_id:uid(),template_version:1,sha256:r.sha256},request=`file-template:${choice.set_id}:${choice.record_id}`;
 await c.query(`INSERT INTO bb_m4_templates(id,version,owner_user_id,document_type,name,broker,material,sha256,creation_request_id,request_hash,market,offering) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[template.template_id,owner,type,r.name,set.origin==='builtin'?'光大证券':'自有模板',material,r.sha256,request,inputManifestHash(choice),p.market,p.offering]);
 await c.query('INSERT INTO bb_file_template_adoptions(owner_user_id,project_id,set_id,record_id,template_ref,material) VALUES($1,$2,$3,$4,$5,$6)',[owner,id,choice.set_id,choice.record_id,template,material]);return {template,material};
}
const matchText=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\.[a-z]+$/,'').replace(/发行人|公司|关于|情况|核查|文件|记录|说明|报告|[\d\s\p{P}\p{S}]/gu,'');
function similarity(a:string,b:string){
 const words=(s:string)=>new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2))),x=words(matchText(a)),y=words(matchText(b));
 if(!x.size||!y.size)return 0;return 2*[...x].filter(w=>y.has(w)).length/(x.size+y.size);
}
export function suggestTemplateMatches(entries:WorkpaperEntry[],set:FileTemplateSet,titles=new Map<string,string>()):FileTemplateMatch[]{return entries.filter(e=>e.kind==='file').map(e=>{
 const same=set.records.filter(r=>r.document_type==='workpaper'&&e.code&&r.code===e.code);
 let candidates=same,reason='编号相同，请核对事项和文件角色。';
 if(!same.length){
  const scored=set.records.filter(r=>r.document_type==='workpaper').map(r=>({r,score:similarity(e.title,titles.get(r.record_id)??r.name)})).filter(s=>s.score>=0.3).sort((a,b)=>b.score-a.score||a.r.record_id.localeCompare(b.r.record_id));
  candidates=scored.filter(s=>s.score>=Math.max(0.3,(scored[0]?.score??1)-0.12)).slice(0,5).map(s=>s.r);
  reason=candidates.length?'按事项名称相似度推荐，请核对角色和适用范围。':'未找到可靠候选，可从模板包中指定。';
 }
 if(candidates.length>1){
  const role=safeRole(e.title),sameRole=candidates.filter(r=>r.role===role);
  if(sameRole.length&&role!=='核查文件'){candidates=sameRole;reason+=' 已优先筛选相同文件角色。';}
 }
 return {item_id:e.id,status:candidates.length===1?'suggested':candidates.length?'multiple':'missing',candidates:candidates.map(({set_id,record_id,sha256})=>({set_id,record_id,sha256})),reason};
});}
