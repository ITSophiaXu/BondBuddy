import {int64,serializeInt64,safeBillingNumber,BILLING_WIRE_VERSION,projectFileCheckBatchSchemas,type FileCheckBatch,type FileCheckBatchQuoteRequest,type FileCheckBatchQuote,type FileCheckBatchCreate,type FileCheckBatchRetry,type ProjectFileOperation} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import type {TSchema} from '@sinclair/typebox';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {project,transaction,uid,conflict,missing,Problem,date,assertCanonicalBusinessRunIdle} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {projectFileSource,projectFileVersions,readProjectFileAsset} from './project-file-storage.js';
import {fileCheckPrice} from './project-file-billing.js';
import {createBatchedFileCheck} from './project-file-consistency.js';
import {assertScopeQuote,assertAcceptedScope,acceptScopeBatch} from './scope-quotations.js';
import {creditBalanceExact,lockCreditAccount} from './billing.js';
import {automaticBillingEnabled} from './automatic-billing-context.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
import {billingWireVersion} from './billing-wire.js';
type Check=Extract<ProjectFileOperation,{operation:'check'}>;
const terminal=['succeeded','failed','cancelled','rejected','test_completed'];
const retryable=['failed','cancelled','rejected'];
async function reusableCheck(c:PoolClient,owner:string,id:string,manifest:Check):Promise<string>{
  const rows=(await c.query(`SELECT o.run_id,o.input_hash,o.result,o.result_hash FROM bb_project_file_operations o
    JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.id=o.run_id
    JOIN bb_project_file_check_quotes q ON q.owner_user_id=o.owner_user_id AND q.run_id=o.run_id
    JOIN bb_artifact_versions a ON a.owner_user_id=r.owner_user_id AND a.run_id=r.id AND a.id=r.artifact_id AND a.version=r.artifact_version
    WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.operation='check' AND o.manifest=$3::jsonb AND r.state='succeeded' AND a.delivery_status='available'
      AND o.result IS NOT NULL AND o.result_hash IS NOT NULL AND NOT bb_task_item_was_refunded(o.owner_user_id,o.run_id,$4)
      AND(q.points=0 OR EXISTS(SELECT 1 FROM bb_credit_reservations res WHERE res.owner_user_id=q.owner_user_id AND res.run_id=q.run_id AND res.quote_id=q.id AND res.state='settled' AND res.charged_points=q.points))
    ORDER BY o.created_at,o.run_id`,[owner,id,JSON.stringify(manifest),manifest.files[0].file_version_id])).rows;
  const original=rows.find(r=>r.input_hash.trim()===inputManifestHash(manifest)&&r.result_hash.trim()===inputManifestHash(r.result));
  if(!original)throw new Problem(409,'INPUT_REVISION_CONFLICT','已购检查范围尚无可复用的原版本成果，本批未执行或扣费；请返回原检查记录核对维护结果。');
  return original.run_id;
}
async function prepare(c:PoolClient,owner:string,id:string,b:FileCheckBatchQuoteRequest){
  if(!automaticBillingEnabled(c))throw new Problem(409,'BILLING_NOT_READY','逐份检查计费尚未启用。');
  const p=await project(c,owner,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
  const source=await projectFileSource(c,owner,id);
  if(!source||source.version_id!==b.expected_source_version_id||source.selection_revision!==b.expected_source_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集说明书已变化，请重新读取本次范围。');
  const available=(await projectFileVersions(c as unknown as Pool,owner,id)).filter(f=>f.latest&&f.document_type!=='workpaper');
  const ids=b.file_version_ids??available.map(f=>f.version_id);
  if(!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw new Problem(422,'INPUT_REQUIRED','请选择1至100份当前关联文件，不能重复。');
  const items=[];
  for(const versionId of ids){
    const f=available.find(f=>f.version_id===versionId);if(!f)throw conflict('INPUT_REVISION_CONFLICT','所选文件已换版或不属于本项目当前关联文件。');
    await readProjectFileAsset(c,owner,f.asset);
    const manifest:Check={version:'project-file-operation-v1',operation:'check',source,files:[{file_id:f.file_id,file_version_id:f.version_id,filename:f.filename,sequence:f.sequence,asset:f.asset,links:f.links}]};
    const price=await fileCheckPrice(c,owner,manifest,id),reused_run_id=int64(price.points)===0n?await reusableCheck(c,owner,id,manifest):null;items.push({manifest,price,reused_run_id});
  }
  // The parent is a stable recovery tag, not a claim that every child shares one price version.
  // A valid accepted old quote must not be invalidated merely by a catalog publication.
  return{p,source,items,points:items.reduce((sum,i)=>int64(sum+int64(i.price.points)),0n),
    version:items.find(i=>int64(i.price.points)>0n)?.price.price_version??await resolveAutomaticTaskPriceVersion(c,owner)};
}
async function idle(c:PoolClient,owner:string,id:string,p:any){
  await assertCanonicalBusinessRunIdle(c,owner,p);
  if((await c.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND task_kind<>\'qa\' AND NOT(state=ANY($3::text[]))',[owner,id,terminal])).rowCount)throw conflict('PROJECT_RUN_ACTIVE','请先完成或结束本项目正在进行的任务。');
}
async function requirePoints(c:PoolClient,owner:string,points:bigint){
  await lockCreditAccount(c,owner);const balance=await creditBalanceExact(c,owner);
  if(balance.available<points)throw new Problem(402,'CREDITS_INSUFFICIENT',`本次需要 ${points.toLocaleString('zh-CN')} 积分，当前可用 ${balance.available.toLocaleString('zh-CN')} 积分；本批文件尚未受理或冻结。`);
}
async function attempt(c:PoolClient,owner:string,id:string,batch:string,ordinal:number,no:number,manifest:Check){
  const runId=uid();await c.query('INSERT INTO bb_project_file_check_attempts(owner_user_id,batch_id,ordinal,attempt,run_id) VALUES($1,$2,$3,$4,$5)',[owner,batch,ordinal,no,runId]);
  await createBatchedFileCheck(c,owner,id,runId,manifest);
}
export async function quoteFileCheckBatch(pool:Pool,owner:string,id:string,b:FileCheckBatchQuoteRequest):Promise<FileCheckBatchQuote>{
  return transaction(pool,async c=>{const p=await prepare(c,owner,id,b);return{source:p.source,points:serializeInt64(p.points),price_version:p.version,price_versions:[...new Set(p.items.map(i=>i.price.price_version))],auto_charge:true,
    items:p.items.map(i=>({file_version_id:i.manifest.files[0].file_version_id,filename:i.manifest.files[0].filename,price_version:i.price.price_version,points:serializeInt64(i.price.points),scope_quote_id:i.price.scope_quote_id??null,reused_run_id:i.reused_run_id,quote_status:i.price.quote_status}))};});
}
export async function readFileCheckBatches(pool:Pool,owner:string,id:string,batchId?:string):Promise<FileCheckBatch[]>{
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');await project(c,owner,id);
    const rows=(await c.query('SELECT * FROM bb_project_file_check_batches WHERE owner_user_id=$1 AND project_id=$2 AND ($3::text IS NULL OR id=$3) ORDER BY created_at DESC,id DESC LIMIT 30',[owner,id,batchId??null])).rows;
    if(batchId&&!rows.length)throw missing();
    const items=(await c.query(`SELECT i.*,COALESCE(i.reused_run_id,a.run_id) AS run_id,CASE WHEN i.reused_run_id IS NOT NULL THEN 0 ELSE a.attempt END AS attempt,r.state,res.state AS reservation_state,res.charged_points FROM bb_project_file_check_batch_items i
      LEFT JOIN LATERAL(SELECT run_id,attempt FROM bb_project_file_check_attempts a WHERE a.owner_user_id=i.owner_user_id AND a.batch_id=i.batch_id AND a.ordinal=i.ordinal ORDER BY attempt DESC LIMIT 1) a ON true
      LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=COALESCE(i.reused_run_id,a.run_id)
      LEFT JOIN bb_credit_reservations res ON res.owner_user_id=i.owner_user_id AND res.run_id=a.run_id
      WHERE i.owner_user_id=$1 AND i.batch_id=ANY($2::text[]) ORDER BY i.ordinal`,[owner,rows.map(r=>r.id)])).rows;
    return rows.map(b=>{const list=items.filter(i=>i.batch_id===b.id);if(!list.length||list.some(i=>!i.run_id||!i.state))throw new Problem(503,'DATA_UNAVAILABLE','原逐份检查记录仍在核对。');
      const done=list.every(i=>terminal.includes(i.state)),succeeded=list.filter(i=>i.state==='succeeded').length;
      const outputs=list.map(i=>({file_version_id:i.file_version_id,filename:i.manifest.files[0].filename,price_version:i.price_snapshot.price_version,points:serializeInt64(i.points),scope_quote_id:i.scope_quote_id,reused_run_id:i.reused_run_id,
        run_id:i.run_id,state:i.state,attempt:i.attempt,charged_points:serializeInt64(!i.reused_run_id&&i.reservation_state==='settled'?i.charged_points??0:0)}));
      return{batch_id:b.id,request_id:b.request_id,source:b.source,created_at:date(b.created_at),price_version:b.price_version,price_versions:[...new Set<string>(outputs.map(i=>i.price_version))],points:serializeInt64(b.points),charged_points:serializeInt64(outputs.reduce((sum,i)=>int64(sum+int64(i.charged_points)),0n)),
        state:done?succeeded===list.length?'complete':succeeded?'partial':'failed':list.every(i=>i.state==='queued')?'queued':'running',items:outputs} satisfies FileCheckBatch;
    });
  });
}
export async function createFileCheckBatch(pool:Pool,owner:string,id:string,b:FileCheckBatchCreate):Promise<FileCheckBatch>{
  const batch=await transaction(pool,async c=>{
    await project(c,owner,id,true);const hash=inputManifestHash({project_id:id,...b});
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner+':file-check-batch:'+b.request_id]);
    const old=(await c.query('SELECT * FROM bb_project_file_check_batches WHERE owner_user_id=$1 AND request_id=$2',[owner,b.request_id])).rows[0];
    if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','原检查请求已用于其他范围。');return old.id;}
    const prepared=await prepare(c,owner,id,b);
    if(int64(b.expected_points)!==prepared.points||b.price_version!==prepared.version||b.scopes.length!==prepared.items.length||new Set(b.scopes.map(s=>s.file_version_id)).size!==b.scopes.length)throw conflict('QUOTE_CHANGED','检查范围或价格已变化，请重新读取。');
    for(const item of prepared.items){const supplied=b.scopes.find(s=>s.file_version_id===item.manifest.files[0].file_version_id);if(!supplied||supplied.scope_quote_id!==(item.price.scope_quote_id??null))throw conflict('QUOTE_CHANGED','逐份检查报价不匹配。');if(item.price.scope_quote_id)await assertScopeQuote(c,supplied.scope_quote_id!,owner,id,'project_file_check',item.price.scope_hash,item.price.points);}
    await idle(c,owner,id,prepared.p);await requirePoints(c,owner,prepared.points);
    const batchId=uid();await c.query('INSERT INTO bb_project_file_check_batches(id,owner_user_id,project_id,request_id,request_hash,source,points,price_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[batchId,owner,id,b.request_id,hash,prepared.source,serializeInt64(prepared.points),prepared.version]);
    for(const [ordinal,item] of prepared.items.entries()){
      await c.query('INSERT INTO bb_project_file_check_batch_items(owner_user_id,batch_id,ordinal,file_version_id,manifest,price_snapshot,scope_quote_id,points,reused_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[owner,batchId,ordinal,item.manifest.files[0].file_version_id,item.manifest,item.price,item.price.scope_quote_id??null,serializeInt64(item.price.points),item.reused_run_id]);
      if(!item.reused_run_id){
        if(item.price.scope_quote_id)await acceptScopeBatch(c,owner,item.price.scope_quote_id,'file_check_batch',batchId,ordinal,item.manifest);
        await attempt(c,owner,id,batchId,ordinal,1,item.manifest);
      }
    }
    return batchId;
  });return(await readFileCheckBatches(pool,owner,id,batch))[0];
}
export async function retryFileCheckBatch(pool:Pool,owner:string,id:string,batch:string,b:FileCheckBatchRetry):Promise<FileCheckBatch>{
  await transaction(pool,async c=>{
    const p=await project(c,owner,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
    const parent=(await c.query('SELECT * FROM bb_project_file_check_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[owner,id,batch])).rows[0];if(!parent)throw missing();
    const hash=inputManifestHash({project_id:id,batch_id:batch,...b});
    const old=(await c.query('SELECT * FROM bb_project_file_check_retries WHERE owner_user_id=$1 AND request_id=$2',[owner,b.request_id])).rows[0];
    if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','原重试请求已用于其他文件。');return;}
    if(new Set(b.expected_attempts.map(i=>i.file_version_id)).size!==b.expected_attempts.length)throw new Problem(422,'VALIDATION_FAILED','重试文件不能重复。');
    const items=(await c.query(`SELECT i.*,a.run_id,a.attempt,r.state,acceptance.id AS acceptance_id FROM bb_project_file_check_batch_items i
      JOIN LATERAL(SELECT run_id,attempt FROM bb_project_file_check_attempts a WHERE a.owner_user_id=i.owner_user_id AND a.batch_id=i.batch_id AND a.ordinal=i.ordinal ORDER BY attempt DESC LIMIT 1) a ON true
      JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=a.run_id
      LEFT JOIN bb_scope_acceptances acceptance ON acceptance.owner_user_id=i.owner_user_id AND acceptance.context='file_check_batch' AND acceptance.context_id=i.batch_id AND acceptance.item_index=i.ordinal
      WHERE i.owner_user_id=$1 AND i.batch_id=$2 ORDER BY i.ordinal`,[owner,batch])).rows;
    const selected=b.expected_attempts.map(expected=>{const item=items.find(i=>i.file_version_id===expected.file_version_id);if(!item||item.run_id!==expected.run_id||!retryable.includes(item.state))throw conflict('INPUT_REVISION_CONFLICT','原文件已完成或重试状态已变化，请刷新。');return item;});
    if(!selected.length)throw new Problem(422,'VALIDATION_FAILED','请选择原失败或已取消文件。');
    const total=selected.reduce((sum,i)=>int64(sum+int64(i.points)),0n);
    if(parent.price_version!==b.price_version||total!==int64(b.expected_points))throw conflict('QUOTE_CHANGED','重试必须沿用原文件价格与积分总额。');
    // Match new admission's project -> coverage -> safety/wallet lock order.
    // Recheck all accepted scopes before any new hold, including zero-price reuse.
    for(const item of selected){if(item.scope_quote_id)await assertAcceptedScope(c,item.acceptance_id,item.scope_quote_id,owner,id,'project_file_check',item.price_snapshot.scope_hash,safeBillingNumber(item.points),item.manifest);
      else{const price=await fileCheckPrice(c,owner,item.manifest,id);if(int64(price.points)!==int64(item.points))throw conflict('QUOTE_CHANGED','原复用范围已变化，请重新核对。');}}
    await idle(c,owner,id,p);await requirePoints(c,owner,total);
    for(const item of selected)await attempt(c,owner,id,batch,item.ordinal,item.attempt+1,item.manifest);
    await c.query('INSERT INTO bb_project_file_check_retries(owner_user_id,request_id,batch_id,request_hash) VALUES($1,$2,$3,$4)',[owner,b.request_id,batch,hash]);
  });return(await readFileCheckBatches(pool,owner,id,batch))[0];
}
export function installProjectFileCheckBatches(app:FastifyInstance,deps:{db:()=>Pool;owner:(r:FastifyRequest)=>Promise<string>}){
  const base='/api/v1/projects/:project_id/project-files/check-batches',params=(r:FastifyRequest)=>r.params as {project_id:string;batch_id:string};
  const strict=(schema:TSchema)=>async(r:FastifyRequest)=>{if(billingWireVersion(r)!==BILLING_WIRE_VERSION||!Value.Check(schema,r.body))throw new Problem(422,'VALIDATION_FAILED','请刷新后按原范围提交；所有积分金额必须使用十进制整数字符串。');};
  app.post(base+'/quote',{preValidation:strict(projectFileCheckBatchSchemas.FileCheckBatchQuoteRequest),schema:{body:projectFileCheckBatchSchemas.FileCheckBatchQuoteRequest,response:{200:projectFileCheckBatchSchemas.FileCheckBatchQuoteResponse}}},async r=>{const owner=await deps.owner(r);return quoteFileCheckBatch(deps.db(),owner,params(r).project_id,r.body as FileCheckBatchQuoteRequest);});
  app.post(base,{preValidation:strict(projectFileCheckBatchSchemas.FileCheckBatchCreateRequest),schema:{body:projectFileCheckBatchSchemas.FileCheckBatchCreateRequest,response:{200:projectFileCheckBatchSchemas.FileCheckBatchResponse}}},async r=>{const owner=await deps.owner(r);return createFileCheckBatch(deps.db(),owner,params(r).project_id,r.body as FileCheckBatchCreate);});
  app.get(base,{schema:{response:{200:projectFileCheckBatchSchemas.FileCheckBatchListResponse}}},async(r,reply)=>{const owner=await deps.owner(r);reply.header('cache-control','private, no-store');return{batches:await readFileCheckBatches(deps.db(),owner,params(r).project_id)};});
  app.get(base+'/:batch_id',{schema:{response:{200:projectFileCheckBatchSchemas.FileCheckBatchResponse}}},async(r,reply)=>{const owner=await deps.owner(r);reply.header('cache-control','private, no-store');return(await readFileCheckBatches(deps.db(),owner,params(r).project_id,params(r).batch_id))[0];});
  app.post(base+'/:batch_id/retry',{preValidation:strict(projectFileCheckBatchSchemas.FileCheckBatchRetryRequest),schema:{body:projectFileCheckBatchSchemas.FileCheckBatchRetryRequest,response:{200:projectFileCheckBatchSchemas.FileCheckBatchResponse}}},async r=>{const owner=await deps.owner(r);return retryFileCheckBatch(deps.db(),owner,params(r).project_id,params(r).batch_id,r.body as FileCheckBatchRetry);});
}
