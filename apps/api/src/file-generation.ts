import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {type Static} from '@sinclair/typebox';
import {FilePreparationSaveSchema,FileGenerationSubmitSchema,FileBuiltinAdoptSchema,FileTemplateImportQuerySchema,FileTemplateCombineSchema,FileTemplateMatchQuerySchema,FileTemplatePinSchema,emptyFileGenerationPreparation,M4_DOCUMENT_FIXED_PRICE,PROJECT_DOCUMENT_CATALOG,
 type FileGenerationPreparation,type FileGenerationSubmit,type FileGenerationBatch,type FileGenerationWorkspace,type FileGenerationQuote,type FileTemplateChoice,type M4DocumentType,type M4MaterialPin,type M4TemplateRef,type WorkpaperEntry} from '@bondbuddy/contracts';
import {project,transaction,uid,date,conflict,missing,digest,Problem,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {projectFileSource} from './project-file-storage.js';
import {readM4Workspace,readM4MaterialPin,saveM4Draft} from './m4-workspace.js';
import {importProspectusMaterial} from './prospectus-import.js';
import {createWorkpaperBatch,readWorkpaperBatch} from './workpapers.js';
import {ensureProjectFileWorkspace,createProjectFileBatch,projectFileBatchDto} from './project-file-workspace.js';
import {parseWorkpaperXlsx} from './workpaper-catalogue.js';
import {renderTemplatePreview} from './file-template-renderer.js';
import {builtinBundle,bundleBytes,storeTemplateSet,readTemplateSets,templateSetDto,templateRecord,storeTemplateMaterial,resolveTemplate,unpackTemplates,templateMatches,TEMPLATE_MAX_BYTES} from './file-template-library.js';
type Db=Pool|PoolClient;
const invalid=(message:string):never=>{throw new Problem(422,'VALIDATION_FAILED',message);};
async function preparation(db:Db,user:string,id:string){
 await project(db,user,id);const r=(await db.query('SELECT * FROM bb_file_generation_preparations WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0];
 return {revision:r?.revision??0,preparation:(r?.preparation??emptyFileGenerationPreparation()) as FileGenerationPreparation};
}
async function catalogue(db:Db,user:string,id:string,cat:string|null){const r=(await db.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,cat])).rows[0];if(!r)throw missing();return r;}
async function validateChoice(db:Db,user:string,id:string,choice:FileTemplateChoice|undefined,type:M4DocumentType){
 if(!choice)invalid('请为每份所选文件指定 Word 模板。');
 if('private_template' in choice!){const p=await project(db,user,id),ref=choice!.private_template,t=(await db.query('SELECT * FROM bb_m4_templates WHERE owner_user_id=$1 AND id=$2 AND version=$3 AND retired_at IS NULL',[user,ref.template_id,ref.template_version])).rows[0];
  if(!t||t.sha256.trim()!==ref.sha256||t.document_type!==type||t.market!==p.market||t.offering!==p.offering)throw missing();await readM4MaterialPin(db,user,t.material,true);
 }else if((await templateRecord(db,user,id,choice!)).record.document_type!==type)invalid('所选模板的文件类型不匹配。');
}
async function quote(db:Db,user:string,id:string,b:FileGenerationSubmit):Promise<{quote:FileGenerationQuote;prep:FileGenerationPreparation;cat:any;source:NonNullable<Awaited<ReturnType<typeof projectFileSource>>>}>{
 const saved=await preparation(db,user,id);if(saved.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','目录、模板或要求已变化，请重新核对。');
 const p=saved.preparation,source=await projectFileSource(db,user,id);
 if(!source||source.version_id!==b.source_version_id||source.selection_revision!==b.source_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集说明书版本已变化，请重新核对。');
 if(!p.document_types.length)invalid('请选择要生成的文件。');
 if(p.document_types.includes('annual')&&!p.target_year)invalid('年度报告需要指定目标年度。');
 let cat:any=null,count=0,omitted:FileGenerationQuote['omitted']=[];
 if(p.document_types.includes('workpaper')){
  cat=await catalogue(db,user,id,p.catalogue_id);const entries=cat.entries as WorkpaperEntry[],selected=entries.filter(e=>e.kind==='file'&&p.item_ids.includes(e.id));
  if(!selected.length||selected.length!==p.item_ids.length)invalid('请从当前底稿目录选择有效的文件条目。');
  for(const entry of selected)await validateChoice(db,user,id,p.mappings[entry.id],'workpaper');
  count=selected.length;omitted=entries.filter(e=>e.kind==='file'&&!p.item_ids.includes(e.id)).map(({id,code,title})=>({id,code,title}));
 }
 for(const type of p.document_types.filter(t=>t!=='workpaper')){if(!PROJECT_DOCUMENT_CATALOG.some(t=>t.id===type))invalid('不支持该文种。');await validateChoice(db,user,id,p.document_templates[type],type);count++;}
 for(const m of p.materials)await readM4MaterialPin(db,user,m);
 const points=count*M4_DOCUMENT_FIXED_PRICE.points;if(points!==b.expected_points||b.price_version!==M4_DOCUMENT_FIXED_PRICE.version)throw conflict('QUOTE_CHANGED','文件数量或价格已变化，请重新核对。');
 return {quote:{count,points,price_version:M4_DOCUMENT_FIXED_PRICE.version,omitted},prep:p,cat,source};
}
async function batchDto(db:Db,user:string,id:string,row:any):Promise<FileGenerationBatch>{
 const docs=row.document_batch_id?(await db.query('SELECT * FROM bb_project_file_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,row.document_batch_id])).rows[0]:null;
 return {batch_id:row.id,created_at:date(row.created_at),points:Number(row.points),workpapers:row.workpaper_batch_id?await readWorkpaperBatch(db,user,id,row.workpaper_batch_id):null,documents:docs?await projectFileBatchDto(db,user,docs):null};
}
export function registerFileGeneration(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs){
 const base='/api/v1/projects/:project_id/file-generation',id=(r:FastifyRequest)=>(r.params as {project_id:string}).project_id;
 app.get(base,async r=>{
  const user=await owner(r),projectId=id(r),saved=await preparation(db(),user,projectId),bundle=await builtinBundle();
  const rows=(await db().query('SELECT * FROM bb_file_generation_batches WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 20',[user,projectId])).rows;
  return {...saved,sets:await readTemplateSets(db(),user,projectId),builtin:{name:'光大证券模板',version:bundle?.version??'',available:!!bundle},batches:await Promise.all(rows.map(row=>batchDto(db(),user,projectId,row)))} satisfies FileGenerationWorkspace;
 });
 app.put(base+'/preparation',{schema:{body:FilePreparationSaveSchema}},async r=>{
  const user=await owner(r),projectId=id(r),b=r.body as Static<typeof FilePreparationSaveSchema>;
  return transaction(db(),async c=>{
   await project(c,user,projectId,true);const current=await preparation(c,user,projectId);
   // Exact retries of a saved version are safe; stale clients cannot overwrite newer work.
   if(current.revision===b.expected_revision+1&&inputManifestHash(current.preparation)===inputManifestHash(b.preparation))return current;
   if(current.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','准备清单已在另一页面修改，请刷新后继续。');
   if(b.preparation.catalogue_id)await catalogue(c,user,projectId,b.preparation.catalogue_id);
   if(b.preparation.template_set_id&&!(await readTemplateSets(c,user,projectId)).some(s=>s.set_id===b.preparation.template_set_id))throw missing();
   for(const pin of Object.values(b.preparation.mappings))await validateChoice(c,user,projectId,pin,'workpaper');
   for(const [type,pin] of Object.entries(b.preparation.document_templates)){if(!PROJECT_DOCUMENT_CATALOG.some(t=>t.id===type))invalid('不支持该文种。');await validateChoice(c,user,projectId,pin,type as M4DocumentType);}
   for(const m of b.preparation.materials)await readM4MaterialPin(c,user,m);
   const row=(await c.query('INSERT INTO bb_file_generation_preparations(owner_user_id,project_id,revision,preparation) VALUES($1,$2,$3,$4) ON CONFLICT(owner_user_id,project_id) DO UPDATE SET revision=EXCLUDED.revision,preparation=EXCLUDED.preparation,updated_at=now() RETURNING revision,preparation',[user,projectId,current.revision+1,b.preparation])).rows[0];return row;
  });
 });
 app.post(base+'/builtin',{schema:{body:FileBuiltinAdoptSchema}},async r=>{
  const user=await owner(r),projectId=id(r),b=r.body as Static<typeof FileBuiltinAdoptSchema>,bundle=await builtinBundle();
  if(!bundle||bundle.version!==b.version)throw conflict('INPUT_REVISION_CONFLICT','内置模板版本不可用，请刷新模板库。');
  return transaction(db(),async c=>{
   await project(c,user,projectId,true);let set,cat;
   if(b.part!=='catalogue'){
    const request=`builtin:${projectId}:${bundle.version}`,hash=inputManifestHash({projectId,bundle}),old=(await c.query('SELECT * FROM bb_file_template_sets WHERE owner_user_id=$1 AND request_id=$2',[user,request])).rows[0];
    if(old){if(old.request_hash.trim()!==hash)throw conflict('INPUT_REVISION_CONFLICT','内置模板版本内容发生变化，请安装新版本。');set=templateSetDto(old);}
    else{const files=[];for(const meta of bundle.records)files.push({name:meta.name,bytes:await bundleBytes(meta.path,meta.sha256),meta});set=await storeTemplateSet(c,blobs(),user,projectId,request,hash,files,'workpaper','builtin',bundle.version);}
   }
   if(b.part!=='templates'){
    const request=`builtin-catalogue:${projectId}:${bundle.version}`,hash=inputManifestHash(bundle.catalogue);
    cat=(await c.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND request_id=$2',[user,request])).rows[0];
    if(cat&&cat.request_hash.trim()!==hash)throw conflict('INPUT_REVISION_CONFLICT','内置目录版本内容发生变化。');
    if(!cat){const bytes=await bundleBytes(bundle.catalogue.path,bundle.catalogue.sha256),parsed=parseWorkpaperXlsx(bytes),material=await storeTemplateMaterial(c,blobs(),user,projectId,bytes,'光大证券底稿目录.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
     cat=(await c.query('INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[uid(),user,projectId,request,hash,material,'光大证券底稿目录.xlsx',JSON.stringify(parsed.entries),JSON.stringify(parsed.warnings),inputManifestHash(parsed)])).rows[0];}
   }
   return {set,...(cat?{catalogue:{catalogue_id:cat.id,sha256:cat.sha256.trim(),filename:cat.filename,entries:cat.entries,warnings:cat.warnings,created_at:date(cat.created_at)}}:{})};
  });
 });
 // Stream parser is shared with material uploads. Read with our own hard byte bound.
 app.post(base+'/templates/import',{schema:{querystring:FileTemplateImportQuerySchema}},async r=>{
  const user=await owner(r),projectId=id(r),q=r.query as Record<string,string>;await project(db(),user,projectId);
  if(!q.request_id||q.request_id.length>128||!/^([a-f0-9]{64})$/.test(q.sha256??'')||!['zip','docx'].includes(q.format)||!['workpaper',...PROJECT_DOCUMENT_CATALOG.map(t=>t.id)].includes(q.document_type))invalid('模板导入参数不完整。');
  const chunks:Buffer[]=[];let total=0;
  if(!r.body||typeof (r.body as any)[Symbol.asyncIterator]!=='function')invalid('请上传模板文件字节。');
  for await(const chunk of r.body as AsyncIterable<Buffer>){total+=chunk.length;if(total>TEMPLATE_MAX_BYTES)invalid('模板包不能超过 64 MB，请拆分上传。');chunks.push(Buffer.from(chunk));}
  const bytes=Buffer.concat(chunks);if(digest(bytes)!==q.sha256)invalid('模板上传校验未通过，请重试原文件。');
  const {files,warnings}=unpackTemplates(bytes,q.format as 'zip'|'docx',(q.filename??'模板.docx').slice(0,500));
  return transaction(db(),c=>storeTemplateSet(c,blobs(),user,projectId,q.request_id,inputManifestHash({projectId,sha256:q.sha256,type:q.document_type,format:q.format,filename:q.filename}),files,q.document_type as M4DocumentType,'private',q.sha256.slice(0,16),warnings));
 });
 app.post(base+'/templates/combine',{schema:{body:FileTemplateCombineSchema}},async r=>{
  const user=await owner(r),projectId=id(r),b=r.body as {request_id:string;set_ids:string[]};return transaction(db(),async c=>{
   await project(c,user,projectId,true);const hash=inputManifestHash({projectId,...b}),old=(await c.query('SELECT * FROM bb_file_template_sets WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
   if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','导入请求已使用。');return templateSetDto(old);}
   const sets=(await c.query('SELECT * FROM bb_file_template_sets WHERE owner_user_id=$1 AND project_id=$2 AND id=ANY($3::text[])',[user,projectId,b.set_ids])).rows;if(sets.length!==b.set_ids.length)throw missing();
   const records=sets.flatMap(s=>s.records).map(r=>({...r,record_id:uid()}));if(records.length>500)invalid('一个模板包最多 500 份 Word。');
   const row=(await c.query('INSERT INTO bb_file_template_sets(id,owner_user_id,project_id,request_id,request_hash,name,version,origin,records,warnings) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[uid(),user,projectId,b.request_id,hash,'我的模板包',hash.slice(0,16),'private',JSON.stringify(records),JSON.stringify(sets.flatMap(s=>s.warnings))])).rows[0];return templateSetDto(row);
  });
 });
 app.post(base+'/template-preview',{schema:{body:FileTemplatePinSchema}},async(r,reply)=>{
  const {record}=await templateRecord(db(),await owner(r),id(r),r.body as Static<typeof FileTemplatePinSchema>);return reply.header('Cache-Control','private, no-store').send(record.preview);
 });
 app.post(base+'/template-preview-pdf',{schema:{body:FileTemplatePinSchema}},async(r,reply)=>{
  const {record}=await templateRecord(db(),await owner(r),id(r),r.body as Static<typeof FileTemplatePinSchema>);
  const bytes=await blobs().getIfExistsBounded(record.object_key,TEMPLATE_MAX_BYTES);if(!bytes||digest(bytes)!==record.sha256)throw missing();
  return reply.header('Cache-Control','private, no-store').send({pdf_base64:(await renderTemplatePreview(bytes)).toString('base64')});
 });
 app.get(base+'/matches',{schema:{querystring:FileTemplateMatchQuerySchema}},async r=>{
  const user=await owner(r),projectId=id(r),q=r.query as {catalogue_id:string;set_id:string};await project(db(),user,projectId);
  const cat=await catalogue(db(),user,projectId,q.catalogue_id);return {matches:await templateMatches(db(),user,projectId,cat.entries,q.set_id)};
 });
 app.post(base+'/quote',{schema:{body:FileGenerationSubmitSchema}},async r=>(await quote(db(),await owner(r),id(r),r.body as FileGenerationSubmit)).quote);
 app.post(base+'/stop-submission',{schema:{body:FileGenerationSubmitSchema}},async r=>{
  const user=await owner(r),projectId=id(r),b=r.body as FileGenerationSubmit,hash=inputManifestHash({projectId,...b});
  return transaction(db(),async c=>{
   await project(c,user,projectId,true);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':file-generation:'+b.request_id]);
   const old=(await c.query('SELECT * FROM bb_file_generation_batches WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
   if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','请求已用于其他文件包。');return {batch:await batchDto(c,user,projectId,old)};}
   const prior=(await c.query('SELECT request_hash FROM bb_file_generation_cancellations WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
   if(prior&&prior.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','请求编号已使用。');
   await c.query('INSERT INTO bb_file_generation_cancellations(owner_user_id,project_id,request_id,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[user,projectId,b.request_id,hash]);return {batch:null};
  });
 });
 app.post(base+'/batches',{schema:{body:FileGenerationSubmitSchema}},async r=>{
  const user=await owner(r),projectId=id(r),b=r.body as FileGenerationSubmit,hash=inputManifestHash({projectId,...b});
  const row=await transaction(db(),async c=>{
   await project(c,user,projectId,true);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':file-generation:'+b.request_id]);
   const old=(await c.query('SELECT * FROM bb_file_generation_batches WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','请求已用于其他文件包。');return old;}
   if((await c.query('SELECT 1 FROM bb_file_generation_cancellations WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rowCount)throw conflict('INPUT_REVISION_CONFLICT','这次提交已停止，请重新确认生成。');
   const {quote:q,prep,cat,source}=await quote(c,user,projectId,b);let workpapers:string|null=null,documents:string|null=null;
   if(prep.document_types.includes('workpaper')){
    const templates:Record<string,{template:M4TemplateRef;material:M4MaterialPin}>={};for(const item of prep.item_ids)templates[item]=await resolveTemplate(c,blobs(),user,projectId,prep.mappings[item],'workpaper');
    workpapers=await createWorkpaperBatch(c,blobs,user,projectId,{request_id:'fg-wp:'+b.request_id,start_mode:'direct',catalogue_id:cat.id,catalogue_sha256:cat.sha256.trim(),item_ids:prep.item_ids,source_version_id:source.version_id,source_selection_revision:source.selection_revision,requirements:prep.requirements,expected_points:prep.item_ids.length*M4_DOCUMENT_FIXED_PRICE.points,price_version:M4_DOCUMENT_FIXED_PRICE.version},{templates,materials:prep.materials});
   }
   const types=prep.document_types.filter(t=>t!=='workpaper');
   if(types.length){
    const t=await ensureProjectFileWorkspace(c,user,projectId),workspace=await readM4Workspace(c,user,t.id),m=await importProspectusMaterial(c,blobs(),user,source.project_id,source.version_id),p=await project(c,user,projectId),drafts=[];
    for(const type of types){
     const chosen=await resolveTemplate(c,blobs(),user,projectId,prep.document_templates[type],type),{version,sha256:_sha,updated_at:_at,...prev}=workspace.drafts[type];
     const materials=[...new Map([...prev.materials,...prep.materials].map(m=>[inputManifestHash(m),m])).values()];if(materials.length>60)invalid('补充资料超过 60 份，请调整后重试。');
     const saved=await saveM4Draft(c,user,t.id,{...prev,source_material:{source_project_id:source.project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256},project_file:{project_id:projectId,source_version_id:source.version_id,source_selection_revision:source.selection_revision},template:chosen.template,edit_base:null,materials,fields:{...prev.fields,market:p.market,offering:p.offering,issuer_name:p.issuer_name??'',...(type==='annual'?{target_year:prep.target_year}:{})},supplemental_requirements:[prev.supplemental_requirements,prep.requirements,type==='annual'?`编制 ${prep.target_year} 年度报告。`:''].filter(Boolean).join('\n').slice(0,12000)},version);
     drafts.push({document_type:type,draft_version:saved.version});
    }
    documents=(await createProjectFileBatch(c,user,projectId,{request_id:'fg-doc:'+b.request_id,source_version_id:source.version_id,expected_selection_revision:source.selection_revision,documents:drafts})).id;
   }
   return (await c.query('INSERT INTO bb_file_generation_batches(id,owner_user_id,project_id,request_id,request_hash,snapshot,workpaper_batch_id,document_batch_id,points) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[uid(),user,projectId,b.request_id,hash,{preparation:prep,source,quote:q},workpapers,documents,q.points])).rows[0];
  });return batchDto(db(),user,projectId,row);
 });
 app.get(base+'/batches/:batch_id',async r=>{const user=await owner(r),projectId=id(r);await project(db(),user,projectId);const row=(await db().query('SELECT * FROM bb_file_generation_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,projectId,(r.params as {batch_id:string}).batch_id])).rows[0];if(!row)throw missing();return batchDto(db(),user,projectId,row);});
}
