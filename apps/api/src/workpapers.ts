import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Static} from '@sinclair/typebox';
import {ZipFile} from 'yazl';
import {PassThrough,Readable} from 'node:stream';
import {WorkpaperImportSchema,WorkpaperStartSchema,WorkpaperActionSchema,WORKPAPER_LIMITS,WORKPAPER_PRICE,
  type WorkpaperDecision,type WorkpaperCatalogue,type WorkpaperWorkspace,type WorkpaperBatch,type WorkpaperEntry,type M4DocumentManifest,type Market,type Offering} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,missing,Problem,date,digest,assertCanonicalBusinessRunIdle,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {readM4MaterialPin,startPinnedM4Run} from './m4-workspace.js';
import {quoteM4} from './m4-billing.js';
import {projectFileSource,readProjectFileAsset} from './project-file-storage.js';
import {importProspectusMaterial} from './prospectus-import.js';
import {loadWorkpaperKnowledge} from './m4-knowledge.js';
import {registerWorkpaperAssessments,readWorkpaperAssessments} from './workpaper-assessments.js';
import {workpaperDocx,explanationParagraphs} from './workpaper-docx.js';
export {workpaperDocx} from './workpaper-docx.js';
import {parseWorkpaperXlsx} from './workpaper-catalogue.js';
type Db=Pool|PoolClient;
const terminal=['succeeded','failed','cancelled','rejected','test_completed'];
const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const catalogueDto=(r:any):WorkpaperCatalogue=>({catalogue_id:r.id,sha256:r.sha256.trim(),filename:r.filename,entries:r.entries,warnings:r.warnings,created_at:date(r.created_at)});
async function event(c:PoolClient,owner:string,id:string,name:string,payload:unknown){
  await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,$4,$5)",[uid(),owner,id,name,payload]);
  await c.query('UPDATE bb_projects SET updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id]);
}
async function ownedBatch(db:Db,owner:string,id:string,batch:string,lock=false){
  await project(db,owner,id);const row=(await db.query(`SELECT * FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 ${lock?'FOR UPDATE':''}`,[owner,id,batch])).rows[0];
  if(!row)throw missing();return row;
}
export async function readWorkpaperBatch(db:Db,owner:string,id:string,batch:string):Promise<WorkpaperBatch>{
  const b=await ownedBatch(db,owner,id,batch);
  const items=(await db.query(`SELECT i.*,r.state run_state,r.stage FROM bb_workpaper_items i LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 ORDER BY i.ordinal`,[owner,batch])).rows;
  const artifacts=(await db.query(`SELECT a.*,v.sha256,r.project_id FROM bb_workpaper_items i JOIN bb_runs r ON r.id=i.run_id AND r.owner_user_id=i.owner_user_id AND r.state='succeeded'
    JOIN bb_m4_artifacts a ON a.owner_user_id=i.owner_user_id AND a.run_id=r.id JOIN bb_artifact_versions v ON v.owner_user_id=a.owner_user_id AND v.id=a.artifact_id AND v.version=a.artifact_version
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND v.delivery_status='available' AND v.quality_status='passed'`,[owner,batch])).rows;
  const charged=(await db.query(`SELECT coalesce(sum(CASE WHEN c.state='released' THEN 0 ELSE coalesce(c.charged_points,CASE WHEN c.state='settled' THEN c.points ELSE 0 END) END),0) amount
    FROM bb_workpaper_attempts a JOIN bb_credit_reservations c ON c.owner_user_id=a.owner_user_id AND c.run_id=a.run_id WHERE a.owner_user_id=$1 AND a.batch_id=$2`,[owner,batch])).rows[0];
  return {batch_id:b.id,topic_id:b.topic_id,catalogue_id:b.catalogue_id,state:b.state,revision:b.revision,source:b.source,total_points:Number(b.total_points),charged_points:Number(charged.amount),created_at:date(b.created_at),error:b.error,
    items:items.map(i=>({entry:i.manifest.input.workpaper.entry,decision:i.manifest.input.workpaper.decision,...(i.explanation?{explanation:{filename:i.explanation.filename,sha256:i.explanation.sha256}}:{}),run_id:i.run_id,state:i.run_state??(i.state==='succeeded'?'succeeded':b.state==='cancelled'?'cancelled':i.state),stage:i.stage??null,attempt:i.attempt,error:i.error,
      artifacts:artifacts.filter(a=>a.run_id===i.run_id).map(a=>({kind:a.kind,filename:a.filename,pin:{source_project_id:a.project_id,artifact_id:a.artifact_id,artifact_version:a.artifact_version,sha256:a.sha256.trim()}}))}))};
}
export async function readWorkpapers(db:Db,owner:string,id:string):Promise<WorkpaperWorkspace>{
  await project(db,owner,id);
  const cats=(await db.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 10',[owner,id])).rows;
  const batches=(await db.query('SELECT id FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 10',[owner,id])).rows;
  return {assessments:await readWorkpaperAssessments(db,owner,id),catalogues:cats.map(catalogueDto),batches:await Promise.all(batches.map(b=>readWorkpaperBatch(db,owner,id,b.id)))};
}

/** A batch is an ordered queue of independent, immutable M4 runs. A failed file does not discard siblings. */
export async function advanceWorkpaperBatch(pool:Pool):Promise<boolean>{
  return transaction(pool,async c=>{
    const b=(await c.query(`SELECT b.* FROM bb_workpaper_batches b JOIN bb_projects p ON p.id=b.project_id AND p.owner_user_id=b.owner_user_id
      WHERE b.state IN ('queued','running') AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY b.updated_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1`)).rows[0];
    if(!b)return false;
    await c.query('UPDATE bb_workpaper_batches SET updated_at=now() WHERE id=$1',[b.id]);
    const running=(await c.query(`SELECT i.*,r.state run_state FROM bb_workpaper_items i LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
      WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.state='running'`,[b.owner_user_id,b.id])).rows;
    for(const item of running){
      if(item.run_state==='paused'){
        await c.query("UPDATE bb_workpaper_batches SET state='paused',error='当前底稿任务已暂停，请先处理该任务，再继续文件包。',revision=revision+1 WHERE id=$1",[b.id]);return true;
      }
      if(!terminal.includes(item.run_state))return false;
      await c.query('UPDATE bb_workpaper_items SET state=$3,error=$4 WHERE batch_id=$1 AND item_id=$2',[b.id,item.item_id,item.run_state==='succeeded'?'succeeded':'failed',item.run_state==='succeeded'?null:'该文件未完成，其他底稿继续处理；可在本批结束后重试。']);
    }
    const next=(await c.query("SELECT * FROM bb_workpaper_items WHERE batch_id=$1 AND state='queued' ORDER BY ordinal LIMIT 1",[b.id])).rows[0];
    if(!next){
      await c.query("UPDATE bb_workpaper_batches SET state=CASE WHEN EXISTS(SELECT 1 FROM bb_workpaper_items WHERE batch_id=$1 AND state='failed') THEN 'partial' ELSE 'complete' END,revision=revision+1,error=NULL WHERE id=$1",[b.id]);return true;
    }
    await c.query('SAVEPOINT workpaper_start');
    try{
      const m=next.manifest as M4DocumentManifest;
      const ids=[...new Set([b.project_id,m.execution_scope_project_id,m.input.source_material!.source_project_id])].sort();
      const locked=(await c.query('SELECT * FROM bb_projects WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL AND archived_at IS NULL ORDER BY id FOR UPDATE NOWAIT',[b.owner_user_id,ids])).rows;
      if(locked.length!==ids.length)throw conflict('INPUT_REVISION_CONFLICT','项目或来源已不可用。');
      await assertCanonicalBusinessRunIdle(c,b.owner_user_id,locked.find(p=>p.id===b.project_id));
      for(const pin of [m.input.source_material!,...m.input.materials])await readM4MaterialPin(c,b.owner_user_id,pin);
      const topic=(await c.query('SELECT * FROM bb_m4_topics WHERE owner_user_id=$1 AND id=$2',[b.owner_user_id,b.topic_id])).rows[0];if(!topic)throw missing();
      const quote=await quoteM4(c,b.owner_user_id,topic.id,m.billing_task,inputManifestHash(m),m);
      if(quote.quote.points!==WORKPAPER_PRICE.points||quote.quote.price_version!==b.price_version)throw conflict('QUOTE_CHANGED','文件生成费用已变化，请重新核对。');
      const run=await startPinnedM4Run(c,b.owner_user_id,topic,`workpaper:${b.id}:${next.item_id}:${next.attempt}`,inputManifestHash({batch:b.id,item:next.item_id,attempt:next.attempt}),m,quote.quote.quote_id,inputManifestHash(m),true);
      await c.query("UPDATE bb_workpaper_items SET run_id=$3,state='running',error=NULL WHERE batch_id=$1 AND item_id=$2",[b.id,next.item_id,run.id]);
      await c.query('INSERT INTO bb_workpaper_attempts(owner_user_id,batch_id,item_id,attempt,run_id) VALUES($1,$2,$3,$4,$5)',[b.owner_user_id,b.id,next.item_id,next.attempt,run.id]);
      await c.query("UPDATE bb_workpaper_batches SET state='running',revision=revision+1,error=NULL WHERE id=$1",[b.id]);
      await event(c,b.owner_user_id,b.project_id,'workpaper.item_started',{batch_id:b.id,item_id:next.item_id,run_id:run.id});return true;
    }catch(error){
      await c.query('ROLLBACK TO SAVEPOINT workpaper_start');
      if(error instanceof Problem&&error.code==='PROJECT_RUN_ACTIVE'||['55P03','40P01'].includes((error as {code?:string}).code??''))return false;
      await c.query("UPDATE bb_workpaper_batches SET state='paused',revision=revision+1,error=$2 WHERE id=$1",[b.id,error instanceof Problem?error.message:'底稿任务暂未启动，请刷新后继续。']);return true;
    }
  });
}

export function registerWorkpapers(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs){
  registerWorkpaperAssessments(app,db,owner);
  const base='/api/v1/projects/:project_id/workpapers',params=(r:FastifyRequest)=>r.params as {project_id:string;batch_id:string};
  app.get(base,async r=>readWorkpapers(db(),await owner(r),params(r).project_id));
  app.post(base+'/catalogues',{schema:{body:WorkpaperImportSchema}},async r=>{
    const user=await owner(r),id=params(r).project_id,b=r.body as Static<typeof WorkpaperImportSchema>,hash=inputManifestHash({project_id:id,...b});
    return transaction(db(),async c=>{
      const p=await project(c,user,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':workpaper-catalogue:'+b.request_id]);
      const prior=(await c.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(prior){if(prior.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此上传请求已使用。');return catalogueDto(prior);}
      if(b.material.source_project_id!==id)throw missing();const material=await readM4MaterialPin(c,user,b.material);
      if(material.media_type!==xlsx)throw new Problem(422,'VALIDATION_FAILED','请上传 XLSX 底稿目录；旧版 XLS 请先另存为 XLSX。');
      const bytes=await blobs().getIfExistsBounded(material.object_key,WORKPAPER_LIMITS.fileBytes);if(!bytes||digest(bytes)!==b.material.sha256)throw new Problem(422,'VALIDATION_FAILED','目录文件超过 10 MB 或暂时不可读取。');
      let parsed:ReturnType<typeof parseWorkpaperXlsx>;
      try{parsed=parseWorkpaperXlsx(bytes);}catch(e){if(e instanceof Problem)throw e;throw new Problem(422,'VALIDATION_FAILED','目录格式无法读取，请另存为标准 XLSX 后上传。');}
      const row=(await c.query('INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [uid(),user,id,b.request_id,hash,b.material,material.filename,JSON.stringify(parsed.entries),JSON.stringify(parsed.warnings),inputManifestHash(parsed)])).rows[0];
      await event(c,user,id,'workpaper.catalogue_imported',{catalogue_id:row.id});return catalogueDto(row);
    });
  });
  app.post(base+'/batches',{schema:{body:WorkpaperStartSchema}},async r=>{
    const user=await owner(r),id=params(r).project_id,b=r.body as Static<typeof WorkpaperStartSchema>,hash=inputManifestHash({project_id:id,...b});
    const batch=await transaction(db(),async c=>{
      const p=await project(c,user,id,true);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':workpaper-batch:'+b.request_id]);
      const prior=(await c.query('SELECT * FROM bb_workpaper_batches WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(prior){if(prior.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此请求已用于其他底稿文件包。');return prior.id;}
      if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
      const cat=(await c.query('SELECT * FROM bb_workpaper_catalogues WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,id,b.catalogue_id])).rows[0];
      if(!cat)throw missing();if(cat.sha256.trim()!==b.catalogue_sha256)throw conflict('INPUT_REVISION_CONFLICT','目录已变化，请重新核对。');
      const selected=(cat.entries as WorkpaperEntry[]).filter(e=>b.item_ids.includes(e.id)&&e.kind==='file');
      if(selected.length!==b.item_ids.length)throw new Problem(422,'VALIDATION_FAILED','文件选择中包含目录或无效行。');
      const assessment=(await c.query("SELECT a.* FROM bb_workpaper_assessments a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.state='succeeded' WHERE a.owner_user_id=$1 AND a.project_id=$2 AND a.run_id=$3",[user,id,b.assessment_id])).rows[0];
      if(!assessment?.result||assessment.result_hash.trim()!==b.assessment_hash||inputManifestHash(assessment.result)!==b.assessment_hash)throw conflict('INPUT_REVISION_CONFLICT','请先完成判断并确认全部不生成项。');
      const {request_id:_request,...assessed}=assessment.manifest.request;
      const {request_id:_start,assessment_id:_id,assessment_hash:_hash,expected_points:_points,price_version:_price,...requested}=b;
      if(inputManifestHash({...assessed,item_ids:[...assessed.item_ids].sort()})!==inputManifestHash({...requested,item_ids:[...requested.item_ids].sort()}))throw conflict('INPUT_REVISION_CONFLICT','目录、选择、要求或募集书已变化，请重新判断。');
      const decisions=assessment.result.decisions as WorkpaperDecision[];
      if(decisions.length!==selected.length||new Set(decisions.map(d=>d.item_id)).size!==selected.length||selected.some(e=>!decisions.some(d=>d.item_id===e.id)))throw conflict('INPUT_REVISION_CONFLICT','判断清单不完整，请重新判断。');
      const generatable=decisions.filter(d=>d.status==='generate').length;
      if(b.price_version!==WORKPAPER_PRICE.version||b.expected_points!==generatable*WORKPAPER_PRICE.points)throw conflict('QUOTE_CHANGED','请重新核对文件数量及费用。');
      if((await c.query("SELECT 1 FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')",[user,id])).rowCount)throw conflict('PROJECT_RUN_ACTIVE','本项目已有底稿文件包待完成，请先继续或结束原文件包。');
      const source=await projectFileSource(c,user,id);
      if(source&&(source.selection_revision>b.source_selection_revision||source.selection_revision===b.source_selection_revision&&source.version_id!==b.source_version_id))
        throw conflict('PROJECT_FILE_BATCH_INPUT_EXPIRED','上次底稿文件包未提交，募集书依据已变化，请刷新页面重新核对。');
      if(!source||source.version_id!==b.source_version_id||source.selection_revision!==b.source_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集说明书版本已变化，请重新核对。');
      await readM4MaterialPin(c,user,cat.material);
      if(!p.market||!p.offering)throw new Problem(422,'INPUT_REQUIRED','请补充项目市场和品种。');
      const imported=await importProspectusMaterial(c,blobs(),user,source.project_id,source.version_id);
      const sourcePin={source_project_id:source.project_id,material_id:imported.material_id,material_version:imported.material_version,sha256:imported.sha256};
      const batchId=uid(),topicId=uid(),child=uid(),scope=p.execution_scope_project_id||id;
      await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,execution_scope_project_id) VALUES($1,$2,$3,'generation',$4,$5,$6,$7)",[child,user,'底稿 · '+p.name,p.issuer_name,p.market,p.offering,scope]);
      await c.query("INSERT INTO bb_m4_topics(id,owner_user_id,project_id,source_project_id,name,creation_request_id,request_hash,surface) VALUES($1,$2,$3,$4,$5,$6,$7,'materials')",[topicId,user,child,id,'底稿 · '+p.name,'workpaper:'+batchId,hash]);
      await c.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,assessment_id,assessment_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12)",[batchId,user,id,topicId,cat.id,b.request_id,hash,source,b.expected_points,b.price_version,b.assessment_id,b.assessment_hash]);
      for(const [ordinal,entry] of selected.entries()){
        const decision=decisions.find(d=>d.item_id===entry.id)!;
        const manifest:M4DocumentManifest={version:'m4-document-input-v1',kind:'document',topic_id:topicId,execution_scope_project_id:scope,project_name:p.name,draft_version:1,
          market:p.market,offering:p.offering,billing_task:'m4_workpaper',template_material:null,knowledge:loadWorkpaperKnowledge(p.market as Market,p.offering as Offering),
          input:{document_type:'workpaper',workpaper:{batch_id:batchId,catalogue_id:cat.id,entry,decision},source_material:sourcePin,materials:[cat.material],template:null,edit_base:null,scope:'whole',
            fields:{market:p.market,offering:p.offering,issuer_name:p.issuer_name??'',source_filename:source.filename,source_version:String(source.sequence)},requirements:[],supplemental_requirements:b.requirements}};
        let explanation=null;
        if(decision.status!=='generate'){
          const bytes=await workpaperDocx('不适用说明（本次未生成情况说明）',explanationParagraphs(entry,decision,source,'判断版本：'+b.assessment_hash+'；确认时间：'+new Date().toISOString()));
          const sha256=digest(bytes),key=`owners/${user}/projects/${id}/workpapers/${batchId}/${entry.id}/${sha256}.docx`;
          await blobs().put(key,bytes,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
          const stored=await blobs().getIfExistsBounded(key,1024*1024);if(!stored||digest(stored)!==sha256)throw Error('WORKPAPER_EXPLANATION_STORE_FAILED');
          explanation={key,sha256,filename:entry.path.replace(/\.docx$/i,'-不适用说明.docx').split('/').at(-1)};
        }
        await c.query('INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest,state,explanation) VALUES($1,$2,$3,$4,$5,$6,$7)',[user,batchId,entry.id,ordinal,manifest,explanation?'succeeded':'queued',explanation]);
      }
      if(!generatable)await c.query("UPDATE bb_workpaper_batches SET state='complete' WHERE id=$1",[batchId]);
      await event(c,user,id,'workpaper.batch_submitted',{batch_id:batchId,count:selected.length});return batchId;
    });return readWorkpaperBatch(db(),user,id,batch);
  });
  app.post(base+'/batches/:batch_id/actions',{schema:{body:WorkpaperActionSchema}},async r=>{
    const user=await owner(r),{project_id:id,batch_id:batch}=params(r),b=r.body as Static<typeof WorkpaperActionSchema>;
    await transaction(db(),async c=>{
      await project(c,user,id,true);const row=await ownedBatch(c,user,id,batch,true);
      if(row.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','底稿任务状态已变化，请刷新后重试。');
      if(['resume','retry_failed'].includes(b.action)&&(await c.query("SELECT 1 FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND id<>$3 AND state IN ('queued','running','paused')",[user,id,batch])).rowCount)
        throw conflict('PROJECT_RUN_ACTIVE','本项目已有其他底稿文件包待完成，请先处理该文件包。');
      let state:string;
      if(b.action==='pause'&&['queued','running'].includes(row.state))state='paused';
      else if(b.action==='cancel'&&['queued','running','paused'].includes(row.state))state='cancelled';
      else if(b.action==='resume'&&row.state==='paused')state='queued';
      else if(b.action==='retry_failed'&&['partial','cancelled'].includes(row.state)){
        const active=(await c.query(`SELECT 1 FROM bb_workpaper_items i JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
          WHERE i.batch_id=$1 AND NOT(r.state=ANY($2::text[]))`,[batch,terminal])).rowCount;
        if(active)throw conflict('PROJECT_RUN_ACTIVE','请先等待当前文件完成。');
        await c.query(`UPDATE bb_workpaper_items i SET run_id=NULL,state='queued',attempt=attempt+1,error=NULL FROM bb_runs r
          WHERE i.batch_id=$1 AND r.id=i.run_id AND r.owner_user_id=i.owner_user_id AND r.state=ANY($2::text[])`,[batch,['failed','cancelled','rejected','test_completed']]);state='queued';
      }else throw conflict('INPUT_REVISION_CONFLICT','当前状态不支持该操作。');
      await c.query('UPDATE bb_workpaper_batches SET state=$2,revision=revision+1,error=NULL,updated_at=now() WHERE id=$1',[batch,state]);
      await event(c,user,id,'workpaper.batch_'+b.action,{batch_id:batch});
    });return readWorkpaperBatch(db(),user,id,batch);
  });
  app.get(base+'/batches/:batch_id/explanations/:item_id',async(r,reply)=>{
    const user=await owner(r),{project_id:id,batch_id:batch}=params(r),item=(r.params as {item_id:string}).item_id;
    return reply.header('Cache-Control','private, no-store').header('Content-Disposition','attachment; filename="explanation.docx"').type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(await explanationBytes(db(),blobs(),user,id,batch,item));
  });
  app.get(base+'/batches/:batch_id/download',async(r,reply)=>{
    const user=await owner(r),{project_id:id,batch_id:batch}=params(r),data=await readWorkpaperBatch(db(),user,id,batch);
    if(!data.items.some(i=>i.artifacts.length||i.explanation))throw new Problem(422,'INPUT_REQUIRED','尚无已完成底稿可打包。');
    const zip=new ZipFile(),stream=new PassThrough();let activeInput:PassThrough|undefined,abortEntry:(()=>void)|undefined;
    zip.outputStream.on('error',e=>stream.destroy(e));zip.outputStream.pipe(stream);
    stream.on('close',()=>{activeInput?.destroy();abortEntry?.();(zip.outputStream as Readable).destroy();});
    // At most one bounded Blob is held at a time; ZIP backpressure keeps hundreds of files bounded.
    void (async()=>{
      try{
        const append=async(path:string,bytes:Buffer)=>{
          if(stream.destroyed)throw Error('DOWNLOAD_CLOSED');
          const finished=new Promise<void>((resolve,reject)=>{
            abortEntry=()=>reject(Error('DOWNLOAD_CLOSED'));
            zip.addReadStreamLazy(path,{},callback=>{const s=new PassThrough();activeInput=s;s.on('end',resolve);s.on('error',reject);callback(null,s);s.end(bytes);bytes=Buffer.alloc(0);});
          });await finished;activeInput=undefined;abortEntry=undefined;
        };
        const manifest=data.items.map(i=>({编号:i.entry.code,名称:i.entry.title,路径:i.entry.path,状态:i.state,来源:`${data.source.filename} V${data.source.sequence}`,判断:i.decision,交付类型:i.explanation?'不适用说明':'底稿',缺口:i.error??'',内容复核:'尚未人工复核'}));
        zip.addBuffer(Buffer.from(JSON.stringify(manifest,null,2)),'生成清单.json');
        for(const item of data.items)if(item.explanation){
          const bytes=await explanationBytes(db(),blobs(),user,id,batch,item.entry.id);
          await append('不适用说明/'+item.entry.path.replace(/\.docx$/i,'-不适用说明.docx'),bytes);
        }
        for(const item of data.items)for(const artifact of item.artifacts){
          if(stream.destroyed)return;
          const row=await readProjectFileAsset(db(),user,{kind:'artifact',pin:artifact.pin});
          const bytes=await blobs().getIfExistsBounded(row.object_key,64*1024*1024);
          if(stream.destroyed)return;
          if(!bytes||digest(bytes)!==artifact.pin.sha256)throw Error('WORKPAPER_DOWNLOAD_UNAVAILABLE');
          const path=(artifact.kind==='preparation_note'?'编制说明/':'底稿/')+item.entry.path;
          // addReadStreamLazy avoids buffering the entire batch in yazl.
          await append(path,bytes);
        }
        zip.end();
      }catch{stream.destroy(Error('底稿打包读取失败，请重试。'));(zip.outputStream as Readable).destroy();}
    })();
    return reply.header('Cache-Control','private, no-store').header('Content-Disposition',`attachment; filename="workpapers.zip"; filename*=UTF-8''${encodeURIComponent('底稿文件包.zip')}`).type('application/zip').send(stream);
  });
}

async function explanationBytes(db:Db,blobs:PrivateBlobs,owner:string,id:string,batch:string,item:string){
 await ownedBatch(db,owner,id,batch);
 const row=(await db.query('SELECT explanation FROM bb_workpaper_items WHERE owner_user_id=$1 AND batch_id=$2 AND item_id=$3',[owner,batch,item])).rows[0];
 if(!row?.explanation)throw missing();const bytes=await blobs.getIfExistsBounded(row.explanation.key,1024*1024);
 if(!bytes||digest(bytes)!==row.explanation.sha256)throw new Problem(503,'DATA_UNAVAILABLE','说明文件暂不可读取，请重试。');return bytes;
}
