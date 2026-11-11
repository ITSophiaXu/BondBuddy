import type {Pool,PoolClient} from 'pg';
import {registerGenerationProgress} from './generation-progress.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {type Static} from '@sinclair/typebox';
import {FilePreparationSaveSchema,FileGenerationSubmitSchema,FileBuiltinAdoptSchema,FileTemplateImportQuerySchema,FileTemplateCombineSchema,FileTemplateMatchQuerySchema,FileTemplatePinSchema,emptyFileGenerationPreparation,M4_DOCUMENT_FIXED_PRICE,PROJECT_DOCUMENT_CATALOG,
 type FileGenerationPreparation,type FileGenerationSubmit,type FileGenerationBatch,type FileGenerationWorkspace,type FileGenerationQuote,type FileTemplateChoice,type M4DocumentType,type M4MaterialPin,type M4TemplateRef,type WorkpaperEntry} from '@bondbuddy/contracts';
import {project,transaction,uid,date,conflict,missing,digest,Problem,type PrivateBlobs} from './data.js';
import {encodeBillingDto,serializeInt64,isOutcomePriceVersion,isAutomaticPriceVersion,OUTCOME_PRICE_VERSION,type BillingWireDto,type FileGenerationPricing} from '@bondbuddy/contracts';
import {automaticBillingEnabled,withAutomaticBilling} from './automatic-billing-context.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
import {loadAutomaticTaskTariff} from './automatic-tariff-repository.js';
import {requireFileUpdateCredits} from './project-file-billing.js';
import {quoteM4} from './m4-billing.js';
import {inputManifestHash} from './production-rule-pin.js';
import {projectFileSource,workpaperFileVersions} from './project-file-storage.js';
import {readM4Workspace,readM4MaterialPin,saveM4Draft,projectFileDocumentManifest} from './m4-workspace.js';
import {importProspectusMaterial} from './prospectus-import.js';
import {createWorkpaperBatch,readWorkpaperBatch} from './workpapers.js';
import {ensureProjectFileWorkspace,createProjectFileBatch,projectFileBatchDto} from './project-file-workspace.js';
import {parseWorkpaperXlsx} from './workpaper-catalogue.js';
import {loadWorkpaperTemplate} from './workpaper-templates.js';
import {templateStructure} from './file-template-preview.js';
import {renderTemplatePreview} from './file-template-renderer.js';
import {builtinBundle,bundleBytes,storeTemplateSet,readTemplateSets,templateSetDto,templateRecord,storeTemplateMaterial,resolveTemplate,unpackTemplates,templateMatches,TEMPLATE_MAX_BYTES} from './file-template-library.js';
type Db=Pool|PoolClient;
const quotationInput=(b:FileGenerationSubmit)=>({expected_revision:b.expected_revision,source_version_id:b.source_version_id,source_selection_revision:b.source_selection_revision});
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
async function pricing(db:Db,user:string,commercial:boolean):Promise<FileGenerationPricing>{
 if(automaticBillingEnabled(db)){
  const version=await resolveAutomaticTaskPriceVersion(db,user),tariff=await loadAutomaticTaskTariff(db,version);
  return {mode:'automatic',price_version:version,workpaper_points:tariff.workpaper.points,document_points:tariff.related.points};
 }
 return {mode:commercial?'scope':'legacy',price_version:commercial?OUTCOME_PRICE_VERSION:M4_DOCUMENT_FIXED_PRICE.version,workpaper_points:M4_DOCUMENT_FIXED_PRICE.points,document_points:commercial?null:M4_DOCUMENT_FIXED_PRICE.points};
}
async function prepareDocuments(c:PoolClient,blobs:PrivateBlobs,user:string,projectId:string,prep:FileGenerationPreparation,source:NonNullable<Awaited<ReturnType<typeof projectFileSource>>>,commercial:boolean){
 const types=prep.document_types.filter(t=>t!=='workpaper');
 const drafts:NonNullable<FileGenerationQuote['documents']>=[];
 if(!types.length)return drafts;
 const t=await ensureProjectFileWorkspace(c,user,projectId),workspace=await readM4Workspace(c,user,t.id),m=await importProspectusMaterial(c,blobs,user,source.project_id,source.version_id),p=await project(c,user,projectId);
 for(const type of types){
  const chosen=await resolveTemplate(c,blobs,user,projectId,prep.document_templates[type],type),{version,sha256:_sha,updated_at:_at,...prev}=workspace.drafts[type];
  // The unified preparation is authoritative. Requoting must not append the same
  // requirements or keep materials removed from this preparation.
  const saved=await saveM4Draft(c,user,t.id,{...prev,source_material:{source_project_id:source.project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256},project_file:{project_id:projectId,source_version_id:source.version_id,source_selection_revision:source.selection_revision},template:chosen.template,edit_base:null,materials:prep.materials,fields:{...prev.fields,market:p.market,offering:p.offering,issuer_name:p.issuer_name??'',...(type==='annual'?{target_year:prep.target_year}:{})},supplemental_requirements:[prep.requirements,type==='annual'?`编制 ${prep.target_year} 年度报告。`:''].filter(Boolean).join('\n').slice(0,12000)},version);
  const manifest=commercial?await projectFileDocumentManifest(c,user,t,type,saved.version):null;
  const quoted=manifest?(await quoteM4(c,user,t.id,manifest.billing_task,inputManifestHash(manifest),manifest,true)).quote:null;
  drafts.push({...quoted,document_type:type,draft_version:saved.version,points:quoted?.points??M4_DOCUMENT_FIXED_PRICE.points});
 }
 return drafts;
}
async function quote(db:PoolClient,blobs:PrivateBlobs,user:string,id:string,b:FileGenerationSubmit,commercial:boolean,enforcePrice=false):Promise<{quote:FileGenerationQuote;pricing:FileGenerationPricing;prep:FileGenerationPreparation;cat:any;source:NonNullable<Awaited<ReturnType<typeof projectFileSource>>>}>{
 const saved=await preparation(db,user,id);if(saved.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','目录、模板或要求已变化，请重新核对。');
 const p=saved.preparation,source=await projectFileSource(db,user,id);
 if(!source||source.version_id!==b.source_version_id||source.selection_revision!==b.source_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集说明书版本已变化，请重新核对。');
 if(!p.document_types.length)invalid('请选择要生成的文件。');
 if(p.document_types.includes('annual')&&!p.target_year)invalid('年度报告需要指定目标年度。');
 let cat:any=null,count=0,omitted:FileGenerationQuote['omitted']=[];
 if(p.document_types.includes('workpaper')){
  cat=await catalogue(db,user,id,p.catalogue_id);const entries=cat.entries as WorkpaperEntry[],selected=entries.filter(e=>e.kind==='file'&&p.item_ids.includes(e.id));
  if(!selected.length||selected.length!==p.item_ids.length)invalid('请从当前底稿目录选择有效的文件条目。');
  if(p.workpaper_template_mode!=='automatic')for(const entry of selected)await validateChoice(db,user,id,p.mappings[entry.id],'workpaper');
  count=selected.length;omitted=entries.filter(e=>e.kind==='file'&&!p.item_ids.includes(e.id)).map(({id,code,title})=>({id,code,title}));
 }
 for(const type of p.document_types.filter(t=>t!=='workpaper')){if(!PROJECT_DOCUMENT_CATALOG.some(t=>t.id===type))invalid('不支持该文种。');await validateChoice(db,user,id,p.document_templates[type],type);count++;}
 for(const m of p.materials)await readM4MaterialPin(db,user,m);
 const price=await pricing(db,user,commercial),documents=commercial?await prepareDocuments(db,blobs,user,id,p,source,true):undefined;
 const points=(p.document_types.includes('workpaper')?p.item_ids.length*price.workpaper_points:0)+(documents?documents.reduce((sum,d)=>sum+d.points,0):p.document_types.filter(t=>t!=='workpaper').length*M4_DOCUMENT_FIXED_PRICE.points);
 const ready=!documents?.some(d=>d.quote_status!=='ready');
 if(enforcePrice||!commercial){
  if(!ready)throw conflict('QUOTE_REQUIRED','文件范围报价待核实，请查看各份文件的报价状态。');
  if(points!==b.expected_points||b.price_version!==price.price_version)throw conflict('QUOTE_CHANGED','文件数量或价格已变化，请重新核对。');
  if(documents?.length&&(b.document_quotes?.length!==documents.length||documents.some(d=>!b.document_quotes?.some(q=>q.document_type===d.document_type&&q.draft_version===d.draft_version&&q.scope_quote_id===d.scope_quote_id))))throw conflict('QUOTE_CHANGED','文件模板、要求或范围报价已变化，请重新核对。');
 }
 return {quote:{count,points,price_version:price.price_version,omitted,...(commercial?{auto_charge:price.mode==='automatic',quote_status:ready?'ready':'pending_scope',documents}: {})},pricing:price,prep:p,cat,source};
}
async function batchDto(db:Db,user:string,id:string,row:any,files?:Parameters<typeof readWorkpaperBatch>[4]):Promise<BillingWireDto<FileGenerationBatch,'fileGenerationBatch'>>{
 const docs=row.document_batch_id?(await db.query('SELECT * FROM bb_project_file_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,row.document_batch_id])).rows[0]:null;
 return {batch_id:row.id,created_at:date(row.created_at),points:serializeInt64(row.points),workpapers:row.workpaper_batch_id?await readWorkpaperBatch(db,user,id,row.workpaper_batch_id,files):null,documents:docs?await projectFileBatchDto(db,user,docs):null};
}
export function registerFileGeneration(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs,commercial=false){
 registerGenerationProgress(app,db,owner,'file-generation');
 const base='/api/v1/projects/:project_id/file-generation',id=(r:FastifyRequest)=>(r.params as {project_id:string}).project_id;
 app.get(base,async r=>{
  const user=await owner(r),projectId=id(r),saved=await preparation(db(),user,projectId),bundle=await builtinBundle();
  const rows=(await db().query('SELECT * FROM bb_file_generation_batches WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[user,projectId])).rows;
  const files=rows.some(row=>row.workpaper_batch_id)?await workpaperFileVersions(db(),user,projectId,false):undefined;
  return encodeBillingDto('fileGenerationWorkspace',{...saved,pricing:await pricing(db(),user,commercial),sets:await readTemplateSets(db(),user,projectId),builtin:{name:'光大证券模板',version:bundle?.version??'',available:!!bundle},batches:await Promise.all(rows.map(row=>batchDto(db(),user,projectId,row,files)))} satisfies Omit<FileGenerationWorkspace,'batches'> & {batches:BillingWireDto<FileGenerationBatch,'fileGenerationBatch'>[]});
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
 app.get(base+'/system-templates',async(r,reply)=>{
  await project(db(),await owner(r),id(r));
  const families=['综合核查记录','专项核查文件','发行人说明','诚信查询记录','访谈记录','培训底稿','不适用说明'];
  const templates=await Promise.all(families.map(async family=>({family,preview:await templateStructure(loadWorkpaperTemplate({code:'',title:family}).bytes,family)})));
  return reply.header('Cache-Control','private, no-store').send({templates});
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
 app.post(base+'/quote',{schema:{body:FileGenerationSubmitSchema}},async r=>{
  const user=await owner(r),projectId=id(r);
  return transaction(db(),async c=>{
   await project(c,user,projectId,true);const b=r.body as FileGenerationSubmit,result=(await quote(c,blobs(),user,projectId,b,commercial)).quote;
   if(!result.auto_charge||result.quote_status!=='ready')return result;
   const quoteId=uid(),expires=new Date(Math.min(Date.now()+7*86400000,...(result.documents??[]).map(d=>Date.parse(d.scope_expires_at??'')||Infinity))).toISOString();
   const saved={...result,quote_id:quoteId,expires_at:expires};
   await c.query('INSERT INTO bb_file_generation_quotes(id,owner_user_id,project_id,input_hash,quote,price_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[quoteId,user,projectId,inputManifestHash(quotationInput(b)),saved,result.price_version,expires]);
   return saved;
  });
 });
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
   const locked=b.quote_id?(await c.query('SELECT *,expires_at>clock_timestamp() AS valid FROM bb_file_generation_quotes WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 FOR UPDATE',[b.quote_id,user,projectId])).rows[0]:null;
   if(b.quote_id&&(!locked||!locked.valid||locked.input_hash.trim()!==inputManifestHash(quotationInput(b))||locked.accepted_batch_id||locked.price_version!==b.price_version||Number(locked.quote.points)!==b.expected_points))throw conflict('QUOTE_CHANGED','原文件包报价已失效或范围不一致，请重新准备。');
   const pin=locked&&isAutomaticPriceVersion(locked.price_version)?locked.price_version:undefined;
   const prepared=pin?await withAutomaticBilling(c,true,()=>quote(c,blobs(),user,projectId,b,commercial,true),pin):await quote(c,blobs(),user,projectId,b,commercial,true);
   const {quote:q,pricing:price,prep,cat,source}=prepared;let workpapers:string|null=null,documents:string|null=null;
   // Check the entire mixed package under the wallet lock before either child is
   // admitted. Each original child keeps its own accepted tariff and settlement.
   if(price.mode==='automatic')await requireFileUpdateCredits(c,user,q.points,true);
   if(prep.document_types.includes('workpaper')){
    const automatic=prep.workpaper_template_mode==='automatic';
    const templates:Record<string,{template:M4TemplateRef;material:M4MaterialPin}>={};if(!automatic)for(const item of prep.item_ids)templates[item]=await resolveTemplate(c,blobs(),user,projectId,prep.mappings[item],'workpaper');
    const create=()=>createWorkpaperBatch(c,blobs,user,projectId,{request_id:'fg-wp:'+b.request_id,start_mode:'direct',catalogue_id:cat.id,catalogue_sha256:cat.sha256.trim(),item_ids:prep.item_ids,source_version_id:source.version_id,source_selection_revision:source.selection_revision,requirements:prep.requirements,expected_points:prep.item_ids.length*price.workpaper_points,price_version:price.mode==='automatic'?price.price_version:M4_DOCUMENT_FIXED_PRICE.version},automatic?undefined:{templates,materials:prep.materials},automatic?prep.materials:[]);
    workpapers=pin?await withAutomaticBilling(c,true,create,pin):await create();
   }
   const types=prep.document_types.filter(t=>t!=='workpaper');
   if(types.length){
    const drafts=q.documents??await prepareDocuments(c,blobs(),user,projectId,prep,source,false);
    const create=()=>createProjectFileBatch(c,user,projectId,{request_id:'fg-doc:'+b.request_id,source_version_id:source.version_id,expected_selection_revision:source.selection_revision,documents:drafts.map(d=>({document_type:d.document_type as (typeof types)[number],draft_version:d.draft_version,...(commercial?{scope_quote_id:d.scope_quote_id}:{})})),...(commercial&&isOutcomePriceVersion(q.price_version)?{price_version:q.price_version,expected_points:drafts.reduce((sum,d)=>sum+d.points,0)}:{})},commercial);
    const batch=pin?await withAutomaticBilling(c,true,create,pin):await create();
    if('scope_pending' in batch)throw conflict('QUOTE_REQUIRED','文件范围报价尚未就绪，本批文件均未提交。');
    documents=batch.id;
   }
   const batch=(await c.query('INSERT INTO bb_file_generation_batches(id,owner_user_id,project_id,request_id,request_hash,snapshot,workpaper_batch_id,document_batch_id,points) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[uid(),user,projectId,b.request_id,hash,{preparation:prep,source,quote:locked?.quote??q},workpapers,documents,q.points])).rows[0];
   if(locked)await c.query('UPDATE bb_file_generation_quotes SET accepted_batch_id=$2 WHERE id=$1',[locked.id,batch.id]);return batch;
  });return batchDto(db(),user,projectId,row);
 });
 app.get(base+'/batches/:batch_id',async r=>{const user=await owner(r),projectId=id(r);await project(db(),user,projectId);const row=(await db().query('SELECT * FROM bb_file_generation_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,projectId,(r.params as {batch_id:string}).batch_id])).rows[0];if(!row)throw missing();return batchDto(db(),user,projectId,row);});
}
