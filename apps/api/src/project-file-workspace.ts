import {assertBatchAdmission} from './batch-admission.js';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Static} from '@sinclair/typebox';
import {PROJECT_DOCUMENT_CATALOG,projectFileSchemas,type M4DocumentManifest,type ProjectFileBatch,type ScopeLine} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,missing,Problem,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {readM4Workspace,saveM4Draft,projectFileDocumentManifest,startPinnedM4Run,readM4MaterialPin} from './m4-workspace.js';
import {quoteM4} from './m4-billing.js';
import {AUTOMATIC_PRICE_VERSION,OUTCOME_PRICE_VERSION,isOutcomePriceVersion} from '@bondbuddy/contracts';
import {OUTCOME_MODE,outcomeMetadata} from './outcome-pricing.js';
import {importProspectusMaterial} from './prospectus-import.js';
import {projectFileSource,projectFileVersions,projectFileFamily,appendProjectFile} from './project-file-storage.js';
import {acceptScopeBatch} from './scope-quotations.js';
import {automaticBillingEnabled} from './automatic-billing-context.js';
import {requireFileUpdateCredits} from './project-file-billing.js';

type Db=Pool|PoolClient;
type BatchItem={pricing_mode?:typeof OUTCOME_MODE;scope_quote_id?:string;scope_acceptance_id?:string;scope_expires_at?:string|null;points?:number;scope_lines?:ScopeLine[];manifest:M4DocumentManifest;run_id:string|null;attempt:number;error:string|null};
const terminal=['succeeded','test_completed','failed','cancelled','rejected'];
async function event(c:PoolClient,owner:string,id:string,type:string,payload:unknown){
  await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,$4,$5)`,[uid(),owner,id,type,payload]);
  await c.query('UPDATE bb_projects SET updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id]);
}
export async function ensureProjectFileWorkspace(c:PoolClient,owner:string,id:string){
  const p=await project(c,owner,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
  const saved=(await c.query(`SELECT t.* FROM bb_project_file_workspaces w JOIN bb_m4_topics t ON t.owner_user_id=w.owner_user_id AND t.id=w.topic_id
    WHERE w.owner_user_id=$1 AND w.project_id=$2`,[owner,id])).rows[0];
  if(saved)return saved;
  let t=(await c.query(`SELECT t.* FROM bb_m4_topics t WHERE t.owner_user_id=$1 AND t.surface='materials'
    AND (t.source_project_id=$2 OR t.project_id=$2) AND NOT EXISTS(SELECT 1 FROM bb_project_file_workspaces w WHERE w.topic_id=t.id)
    ORDER BY t.created_at LIMIT 1 FOR UPDATE`,[owner,id])).rows[0];
  if(!t){
    const projectId=uid(),topicId=uid(),key='project-files:'+id;
    await c.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,execution_scope_project_id)
      VALUES($1,$2,$3,'generation',$4,$5,$6,$7)`,[projectId,owner,p.name,p.issuer_name,p.market,p.offering,p.execution_scope_project_id||id]);
    t=(await c.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,source_project_id,name,creation_request_id,request_hash,surface)
      VALUES($1,$2,$3,$4,$5,$6,$7,'materials') RETURNING *`,[topicId,owner,projectId,id,p.name,key,inputManifestHash({project_id:id})])).rows[0];
  }
  await c.query('INSERT INTO bb_project_file_workspaces(owner_user_id,project_id,topic_id) VALUES($1,$2,$3)',[owner,id,t.id]);
  await event(c,owner,id,'project.file_workspace_prepared',{topic_id:t.id});return t;
}
export async function projectFileBatchDto(db:Db,owner:string,row:any):Promise<ProjectFileBatch>{
  const items=row.items as BatchItem[],ids=items.flatMap(i=>i.run_id?[i.run_id]:[]);
  const runs=(await db.query('SELECT id,state FROM bb_runs WHERE owner_user_id=$1 AND id=ANY($2::text[])',[owner,ids])).rows;
  const scopeIds=items.flatMap(i=>i.pricing_mode===OUTCOME_MODE&&i.scope_quote_id?[i.scope_quote_id]:[]);
  const scopes=scopeIds.length?(await db.query('SELECT id,price_version FROM bb_scope_quotations WHERE owner_user_id=$1 AND id=ANY($2::text[])',[owner,scopeIds])).rows:[];
  const scopeVersions=new Map(scopes.map(scope=>[scope.id,scope.price_version]));
  return {batch_id:row.id,state:row.state,items:items.filter(i=>i.manifest.input.document_type!=='workpaper').map(i=>({document_type:i.manifest.input.document_type as ProjectFileBatch['items'][number]['document_type'],run_id:i.run_id,
    state:runs.find(r=>r.id===i.run_id)?.state??'queued',error:i.error,...(i.pricing_mode===OUTCOME_MODE?{...outcomeMetadata(i.points??0,i.points??0,1,scopeVersions.get(i.scope_quote_id)),scope_quote_id:i.scope_quote_id,scope_expires_at:i.scope_expires_at??null,scope_lines:i.scope_lines??[],quote_status:'ready'}:{})}))};
}
export async function readProjectFileWorkspace(db:Pool,owner:string,id:string,commercial=false){
  await project(db,owner,id);
  const binding=(await db.query('SELECT topic_id FROM bb_project_file_workspaces WHERE owner_user_id=$1 AND project_id=$2',[owner,id])).rows[0];
  if(!binding)throw missing();
  const batches=(await db.query('SELECT * FROM bb_project_file_batches WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 20',[owner,id])).rows;
  return {project_id:id,source:await projectFileSource(db,owner,id),workspace:await readM4Workspace(db,owner,binding.topic_id),
    files:await projectFileVersions(db,owner,id),batches:await Promise.all(batches.map(b=>projectFileBatchDto(db,owner,b))),...(commercial?{price:{points:0,...outcomeMetadata(0,0,1,automaticBillingEnabled(db)?AUTOMATIC_PRICE_VERSION:OUTCOME_PRICE_VERSION),quote_status:'pending_scope' as const,scope_lines:[]}}:{})};
}

/** The worker starts each frozen item after its predecessor; closing the browser cannot lose a batch. */
export async function advanceProjectFileBatch(pool:Pool):Promise<boolean>{
  return transaction(pool,async c=>{
    const row=(await c.query(`SELECT b.* FROM bb_project_file_batches b JOIN bb_projects p ON p.owner_user_id=b.owner_user_id AND p.id=b.project_id
      WHERE b.state IN ('queued','running') AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY b.updated_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1`)).rows[0];
    if(!row)return false;
    const items=row.items as BatchItem[];
    let next=-1,active=0;
    for(const [i,item] of items.entries()){
      if(!item.run_id){if(next<0)next=i;continue;}
      const r=(await c.query('SELECT state FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[row.owner_user_id,item.run_id])).rows[0];
      if(!r)throw conflict('INPUT_REVISION_CONFLICT','批次任务记录不可用。');
      if(!terminal.includes(r.state)){active++;continue;}
      if(r.state!=='succeeded'){
        item.error='该文件任务未完成，请核对任务状态后继续。';
        await c.query("UPDATE bb_project_file_batches SET state='paused',items=$2,updated_at=now() WHERE id=$1",[row.id,JSON.stringify(items)]);return true;
      }
    }
    if(active>=(row.max_parallel??1)||next<0&&active){await c.query('UPDATE bb_project_file_batches SET updated_at=now() WHERE id=$1',[row.id]);return false;}
    if(next<0){await c.query("UPDATE bb_project_file_batches SET state='complete',updated_at=now() WHERE id=$1",[row.id]);return true;}
    const item=items[next],m=item.manifest,owner=row.owner_user_id;
    await c.query('SAVEPOINT start_file');
    try{
    const ids=[...new Set([m.execution_scope_project_id,m.input.source_material!.source_project_id])];
    const locked=(await c.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL AND archived_at IS NULL ORDER BY id FOR NO KEY UPDATE NOWAIT',[owner,ids])).rows;
    if(locked.length!==ids.length)throw conflict('INPUT_REVISION_CONFLICT','项目已归档或来源不可用，请恢复后继续。');
    await assertBatchAdmission(c,owner,m.execution_scope_project_id,'generation:'+row.id,m.input.document_type,row.max_parallel??1);
    const t=(await c.query('SELECT * FROM bb_m4_topics WHERE owner_user_id=$1 AND id=$2',[owner,row.topic_id])).rows[0];
    if(!t)throw missing();
    const quote=await quoteM4(c,owner,t.id,m.billing_task,inputManifestHash(m),m,item.pricing_mode===OUTCOME_MODE,item.scope_acceptance_id?{scope_quote_id:item.scope_quote_id!,scope_acceptance_id:item.scope_acceptance_id,points:item.points!}:undefined);
    if(item.pricing_mode===OUTCOME_MODE&&(quote.quote.quote_status!=='ready'||quote.quote.scope_quote_id!==item.scope_quote_id||quote.quote.points!==item.points))
      throw conflict('QUOTE_CHANGED','已确认的文件范围或费用不一致，请核对原范围报价。');
    const request=`project-files:${row.id}:${next}:${item.attempt}`;
    const run=await startPinnedM4Run(c,owner,t,request,inputManifestHash({batch:row.id,index:next,attempt:item.attempt}),m,quote.quote.quote_id,inputManifestHash(m),true);
    item.run_id=run.id;
    await c.query("UPDATE bb_project_file_batches SET state='running',items=$2,updated_at=now() WHERE id=$1",[row.id,JSON.stringify(items)]);
    await event(c,owner,row.project_id,'project.file_generation_started',{batch_id:row.id,run_id:run.id});return true;
    }catch(error){
      await c.query('ROLLBACK TO SAVEPOINT start_file');
      if(error instanceof Problem&&error.code==='PROJECT_RUN_ACTIVE'||['55P03','40P01'].includes((error as {code?:string}).code??'')){
        await c.query('UPDATE bb_project_file_batches SET updated_at=now() WHERE id=$1',[row.id]);return false;
      }
      item.error=error instanceof Problem?error.message:'文件任务未启动，请刷新后重试。';
      await c.query("UPDATE bb_project_file_batches SET state='paused',items=$2,updated_at=now() WHERE id=$1",[row.id,JSON.stringify(items)]);return true;
    }
  });
}

export async function createProjectFileBatch(c:PoolClient,user:string,projectId:string,b:Static<typeof projectFileSchemas.ProjectFileBatchRequest>,commercial=false){
      const t=await ensureProjectFileWorkspace(c,user,projectId),hash=inputManifestHash({project_id:projectId,...b});
      const old=(await c.query('SELECT * FROM bb_project_file_batches WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','请求已用于其他文件选择。');return old;}
      if(new Set(b.documents.map(d=>d.document_type)).size!==b.documents.length)throw new Problem(422,'VALIDATION_FAILED','文件类型不能重复。');
      const source=await projectFileSource(c,user,projectId);
      if(!source)throw conflict('INPUT_REVISION_CONFLICT','募集书版本已变化，请重新确认。');
      // Only after the locked project's receipt lookup can an irreversible input
      // change prove that an uncertain request did not create this package.
      // Future revisions and temporarily unavailable sources are not that proof.
      if(source.selection_revision>b.expected_selection_revision||source.selection_revision===b.expected_selection_revision&&source.version_id!==b.source_version_id)
        throw conflict('PROJECT_FILE_BATCH_INPUT_EXPIRED','上次文件包未被接收，募集书依据已换版，请重新准备并确认。');
      if(source.version_id!==b.source_version_id||source.selection_revision!==b.expected_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集书版本已变化，请重新确认。');
      if((await c.query("SELECT 1 FROM bb_project_file_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')",[user,projectId])).rowCount)throw conflict('PROJECT_RUN_ACTIVE','已有文件包尚未完成，请先处理当前任务。');
      const items:BatchItem[]=[];
      let total=0,pending=false;
      for(const d of b.documents){
        const current=(await c.query('SELECT version FROM bb_m4_drafts WHERE owner_user_id=$1 AND topic_id=$2 AND document_type=$3',[user,t.id,d.document_type])).rows[0];
        if(current&&Number(current.version)>d.draft_version)
          throw conflict('PROJECT_FILE_BATCH_INPUT_EXPIRED','上次文件包未被接收，文件草稿已换版，请重新准备并确认。');
        const manifest=await projectFileDocumentManifest(c,user,t,d.document_type,d.draft_version);
        if(manifest.input.project_file?.project_id!==projectId||manifest.input.project_file?.source_version_id!==source.version_id||manifest.input.project_file.source_selection_revision!==source.selection_revision)throw conflict('INPUT_REVISION_CONFLICT','文件草稿的募集书版本与本次选择不同。');
        const quote=commercial?(await quoteM4(c,user,t.id,manifest.billing_task,inputManifestHash(manifest),manifest,true)).quote:null;
        if(quote&&quote.quote_status!=='ready')pending=true;
        if(quote?.quote_status==='ready'&&d.scope_quote_id!==quote.scope_quote_id)throw conflict('QUOTE_CHANGED','所选文件的范围报价已变化，请重新确认。');
        total+=quote?.points??0;
        items.push({manifest,run_id:null,attempt:1,error:null,...(commercial?{pricing_mode:OUTCOME_MODE,scope_quote_id:quote?.scope_quote_id,scope_expires_at:quote?.scope_expires_at,points:quote?.points,scope_lines:quote?.scope_lines??[]}:{})});
      }
      if(pending)return {scope_pending:true};
      if(commercial&&(!isOutcomePriceVersion(b.price_version)||b.expected_points!==total))throw conflict('QUOTE_CHANGED','请确认每份文件的范围明细和人民币总价后开始。');
      if(automaticBillingEnabled(c))await requireFileUpdateCredits(c,user,total,true);
      const row=(await c.query(`INSERT INTO bb_project_file_batches(id,owner_user_id,project_id,topic_id,request_id,request_hash,items,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *`,[uid(),user,projectId,t.id,b.request_id,hash,JSON.stringify(items)])).rows[0];
      if(commercial){
        for(const [index,item] of items.entries())item.scope_acceptance_id=await acceptScopeBatch(c,user,item.scope_quote_id!,'file_generation_batch',row.id,index,item.manifest);
        await c.query('UPDATE bb_project_file_batches SET items=$2 WHERE id=$1',[row.id,JSON.stringify(items)]);row.items=items;
      }
      await event(c,user,projectId,'project.file_batch_submitted',{batch_id:row.id,document_types:b.documents.map(d=>d.document_type)});return row;
}

export function registerProjectFileWorkspace(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>,blobs:()=>PrivateBlobs,commercial=false){
  const base='/api/v1/projects/:project_id/project-files',id=(r:FastifyRequest)=>(r.params as {project_id:string}).project_id;
  app.post(base+'/workspace',{schema:{body:projectFileSchemas.ProjectFileWorkspaceRequest}},async r=>{
    const user=await owner(r),projectId=id(r);await transaction(db(),c=>ensureProjectFileWorkspace(c,user,projectId));return readProjectFileWorkspace(db(),user,projectId,commercial);
  });
  app.get(base+'/workspace',async r=>readProjectFileWorkspace(db(),await owner(r),id(r),commercial));
  app.get(base,async r=>({files:await projectFileVersions(db(),await owner(r),id(r),(r.query as {include_workpapers?:string}).include_workpapers==='true')}));
  app.post(base+'/batches/quote',{schema:{body:projectFileSchemas.ProjectFileBatchRequest}},async r=>{
    const user=await owner(r),projectId=id(r),b=r.body as Static<typeof projectFileSchemas.ProjectFileBatchRequest>;
    return transaction(db(),async c=>{
      const t=await ensureProjectFileWorkspace(c,user,projectId),source=await projectFileSource(c,user,projectId);
      if(!source||source.version_id!==b.source_version_id||source.selection_revision!==b.expected_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集书版本已变化，请重新确认。');
      if(new Set(b.documents.map(d=>d.document_type)).size!==b.documents.length)throw new Problem(422,'VALIDATION_FAILED','文件类型不能重复。');
      const documents=[];
      for(const d of b.documents){
        const manifest=await projectFileDocumentManifest(c,user,t,d.document_type,d.draft_version);
        if(manifest.input.project_file?.project_id!==projectId||manifest.input.project_file.source_version_id!==source.version_id||manifest.input.project_file.source_selection_revision!==source.selection_revision)throw conflict('INPUT_REVISION_CONFLICT','文件草稿的募集书版本与本次选择不同。');
        const {quote}=await quoteM4(c,user,t.id,manifest.billing_task,inputManifestHash(manifest),manifest,commercial);
        const price=commercial&&isOutcomePriceVersion(quote.price_version)?outcomeMetadata(quote.points,quote.points,1,quote.price_version):null;
        if(commercial&&!price)throw new Problem(503,'BILLING_NOT_READY','文件报价规则版本不可用，请稍后重新核对。');
        documents.push({document_type:d.document_type,draft_version:d.draft_version,points:quote.points,...(commercial?{...price,scope_quote_id:quote.scope_quote_id,quote_status:quote.quote_status,scope_expires_at:quote.scope_expires_at,scope_lines:quote.scope_lines??[]}:{})});
      }
      const points=documents.reduce((sum,d)=>sum+d.points,0),ready=!commercial||documents.every(d=>d.quote_status==='ready');
      const candidateVersion=documents.find(d=>d.price_version)?.price_version;
      const version=isOutcomePriceVersion(candidateVersion)?candidateVersion:OUTCOME_PRICE_VERSION;
      return {points,price_version:commercial?version:null,quote_status:ready?'ready':documents.find(d=>d.quote_status!=='ready')?.quote_status??'pending_scope',documents,...(commercial?outcomeMetadata(points,points,1,version):{})};
    });
  });
  app.post(base+'/batches/:batch_id/actions',{schema:{body:projectFileSchemas.ProjectFileBatchActionRequest}},async r=>{
    const user=await owner(r),projectId=id(r),b=r.body as Static<typeof projectFileSchemas.ProjectFileBatchActionRequest>,batchId=(r.params as {batch_id:string}).batch_id;
    await transaction(db(),async c=>{
      await project(c,user,projectId,true);
      const row=(await c.query('SELECT * FROM bb_project_file_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,projectId,batchId])).rows[0];if(!row)throw missing();
      if(b.action==='cancel'){await c.query("UPDATE bb_project_file_batches SET state='cancelled',updated_at=now() WHERE id=$1",[batchId]);}
      else{
        if(row.state!=='paused')throw conflict('INPUT_REVISION_CONFLICT','文件包状态已变化，请刷新。');
        const items=row.items as BatchItem[];
        for(const item of items){if(item.run_id){const run=(await c.query('SELECT state FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[user,item.run_id])).rows[0];
          if(!run||!terminal.includes(run.state))throw conflict('PROJECT_RUN_ACTIVE','请先在任务详情中处理当前任务。');
          if(run.state!=='succeeded'){item.run_id=null;item.attempt++;item.error=null;}
        }else item.error=null;}
        await c.query("UPDATE bb_project_file_batches SET state='queued',items=$2,updated_at=now() WHERE id=$1",[batchId,JSON.stringify(items)]);
      }
      await event(c,user,projectId,'project.file_batch_'+b.action,{batch_id:batchId});
    });return readProjectFileWorkspace(db(),user,projectId,commercial);
  });
  app.post(base+'/source',{schema:{body:projectFileSchemas.ProjectFileSourceRequest}},async r=>{
    const user=await owner(r),projectId=id(r),b=r.body as Static<typeof projectFileSchemas.ProjectFileSourceRequest>;
    await transaction(db(),async c=>{
      const t=await ensureProjectFileWorkspace(c,user,projectId),source=await projectFileSource(c,user,projectId);
      if(!source)throw missing();if(source.version_id!==b.source_version_id||source.selection_revision!==b.expected_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集书选择已变化，请刷新后重新选择。');
      const m=await importProspectusMaterial(c,blobs(),user,source.project_id,source.version_id),p=await project(c,user,source.project_id);
      if(!p.market||!p.offering)throw new Problem(422,'INPUT_REQUIRED','请先补充项目市场与品种。');
      const w=await readM4Workspace(c,user,t.id);
      for(const type of PROJECT_DOCUMENT_CATALOG.map(d=>d.id)){
        const d=w.drafts[type],{version,sha256:_sha,updated_at:_at,...previous}=d;
        const input={...previous,source_material:{source_project_id:source.project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256},
          project_file:{project_id:projectId,source_version_id:source.version_id,source_selection_revision:source.selection_revision},
          fields:{...previous.fields,market:p.market,offering:p.offering,issuer_name:p.issuer_name??''}};
        if(inputManifestHash(input)!==inputManifestHash(previous))await saveM4Draft(c,user,t.id,input,version);
      }
    });return readProjectFileWorkspace(db(),user,projectId,commercial);
  });
  app.post(base+'/batches',{schema:{body:projectFileSchemas.ProjectFileBatchRequest}},async r=>{
    const user=await owner(r),projectId=id(r),b=r.body as Static<typeof projectFileSchemas.ProjectFileBatchRequest>;
    const batch=await transaction(db(),async c=>{
      return createProjectFileBatch(c,user,projectId,b,commercial);
    });if('scope_pending' in batch)throw conflict('QUOTE_REQUIRED','本次文件范围待核实，请先取得全部文件的范围明细报价后确认。');return projectFileBatchDto(db(),user,batch);
  });
  app.post(base+'/imports',{schema:{body:projectFileSchemas.ProjectFileImportRequest}},async r=>{
    const user=await owner(r),projectId=id(r),b=r.body as Static<typeof projectFileSchemas.ProjectFileImportRequest>;
    await transaction(db(),async c=>{
      const family=await projectFileFamily(c,user,projectId,b.document_type),hash=inputManifestHash({project_id:projectId,...b});
      const old=(await c.query('SELECT * FROM bb_project_file_import_requests WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','请求已用于其他文件。');return;}
      if(family.latest_version_id!==b.expected_latest_version_id)throw conflict('INPUT_REVISION_CONFLICT','项目文件已有新版本，请刷新后重新上传。');
      if(b.material.source_project_id!==projectId)throw new Problem(422,'VALIDATION_FAILED','请上传当前项目的文件。');
      const m=await readM4MaterialPin(c,user,b.material);if(!['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(m.media_type))throw new Problem(422,'VALIDATION_FAILED','项目关联文件支持 Word 或 PDF。');
      const v=await appendProjectFile(c,user,family,{filename:m.filename,asset:{kind:'material',pin:b.material}});
      await c.query('INSERT INTO bb_project_file_import_requests(owner_user_id,request_id,request_hash,file_version_id) VALUES($1,$2,$3,$4)',[user,b.request_id,hash,v.id]);
    });return {files:await projectFileVersions(db(),user,projectId)};
  });
}
